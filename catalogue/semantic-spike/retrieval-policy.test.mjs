import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConfidencePolicy,
  capabilityRowsByName,
  classifyDiscoveryIntent,
  deduplicateCapabilities,
  lexicalFusionPolicy,
  prepareSemanticQuery,
  rerankSemanticResults,
} from "./retrieval-policy.mjs";

test("the intent gate suppresses narrow conversation controls without hiding scoped requests", () => {
  for (const query of [
    "yes",
    "please wait",
    "thanks, that solved it",
    "I agree with that plan",
    "what did I ask before",
    "what is two plus two",
  ]) {
    assert.equal(classifyDiscoveryIntent(query).action, "abstain", query);
  }
  for (const query of [
    "stop a runaway background process",
    "continue a paused deployment",
    "find a skill that can calculate invoices",
    "build a good morning briefing skill",
  ]) {
    assert.equal(classifyDiscoveryIntent(query).action, "search", query);
  }
});

test("lexical-only candidates are reserved for short lookup-like queries", () => {
  assert.deepEqual(lexicalFusionPolicy("code review"), {
    semanticWeight: 1,
    lexicalWeight: 0.75,
    allowLexicalOnly: true,
    maxLexicalBoostSemanticRank: null,
    profile: "short-lookup",
  });
  assert.equal(lexicalFusionPolicy("review").profile, "short-lookup");
  assert.equal(lexicalFusionPolicy("review-ticket", {
    capabilityNames: new Set(["review ticket"]),
  }).profile, "short-lookup");
  assert.equal(lexicalFusionPolicy("create-implementation-plan", {
    capabilityNames: new Set(["create implementation plan"]),
  }).profile, "short-lookup");
  assert.deepEqual(lexicalFusionPolicy("what capability can challenge the quality of a diff"), {
    semanticWeight: 1,
    lexicalWeight: 0,
    allowLexicalOnly: false,
    maxLexicalBoostSemanticRank: null,
    profile: "semantic-natural-language",
  });
});

test("semantic preparation recognizes autonomous learning but not generic agent chat", () => {
  assert.equal(prepareSemanticQuery("I need that my agent learns stuff on its own").intent, "self-learning-agent");
  assert.equal(prepareSemanticQuery("agent that learns while chatting").intent, "self-learning-agent");
  assert.equal(prepareSemanticQuery("an assistant that adapts automatically from feedback").intent, "self-learning-agent");
  assert.equal(prepareSemanticQuery("build a chat agent").intent, null);
  assert.equal(prepareSemanticQuery("teach my agent Spanish").intent, null);
});

test("semantic intent reranking promotes self-learning capabilities", () => {
  const records = [
    { name: "ai-agent", description: "Build a conversational agent", ecosystem: "vercel" },
    { name: "self-improving-agent", description: "Continuously evolve from experience", ecosystem: "vercel" },
    { name: "self-improve", description: "Capture corrections for future sessions", ecosystem: "official" },
  ];
  const reranked = rerankSemanticResults([
    { row: 0, score: 0.91 },
    { row: 1, score: 0.89 },
    { row: 2, score: 0.88 },
  ], records, "self-learning-agent");
  assert.deepEqual(reranked.map(({ row }) => row), [1, 2, 0]);
});

test("centered confidence suppresses only scores below the conservative threshold", () => {
  const search = { action: "search", reason: "test", detector: "test" };
  assert.deepEqual(applyConfidencePolicy(search, { topCenteredScore: 0.072 }, 0.0725), {
    action: "abstain",
    reason: "low-centered-confidence",
    detector: "corpus-centered-v1",
    score: 0.072,
    threshold: 0.0725,
  });
  assert.equal(applyConfidencePolicy(search, { topCenteredScore: 0.0725 }, 0.0725), search);
});

test("deduplication preserves same-name mirrors and variants while backfilling slots", () => {
  const records = [
    { name: "messages-ops", description: "Read live messages" },
    { name: "messages ops", description: "Read live messages" },
    { name: "calendar", description: "Schedule meetings" },
    { name: "surprise-me", description: "Combine enabled skills" },
    { name: "surprise me", description: "Analyze a reading history" },
    { name: "messages_ops", description: "Read live messages" },
  ];
  const candidates = [0, 1, 2, 3, 4].map((row) => ({ row, score: 5 - row }));
  const similarities = new Map([["3:4", 0.92]]);
  const result = deduplicateCapabilities(candidates, records, {
    limit: 3,
    similarity: (first, second) => similarities.get(`${first}:${second}`) ?? 0,
    allRowsByName: capabilityRowsByName(records),
  });
  assert.deepEqual(result.results.map(({ row }) => row), [0, 2, 3]);
  assert.deepEqual(result.results[0].alternates.map(({ row, relation }) => ({ row, relation })), [
    { row: 1, relation: "mirror" },
    { row: 5, relation: "mirror" },
  ]);
  assert.deepEqual(result.results[2].alternates.map(({ row, relation }) => ({ row, relation })), [
    { row: 4, relation: "variant" },
  ]);
  assert.equal(result.collapsed, 3);
});
