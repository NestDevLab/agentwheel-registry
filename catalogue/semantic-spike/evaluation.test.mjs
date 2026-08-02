import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  duplicateCapabilityGroups,
  parseJudgment,
  summarizeEvaluation,
  validateEvaluationSet,
} from "./evaluation.mjs";

test("judgments accept relevant ranks and explicit control actions", () => {
  assert.deepEqual(parseJudgment("1, 3, 1", 3), { action: "record", relevantRanks: [1, 3] });
  assert.deepEqual(parseJudgment("n", 3), { action: "record", relevantRanks: [] });
  assert.deepEqual(parseJudgment("skip", 3), { action: "skip" });
  assert.deepEqual(parseJudgment("q", 3), { action: "quit" });
  assert.throws(() => parseJudgment("4", 3), /between 1 and 3/);
  assert.throws(() => parseJudgment("maybe", 3), /result numbers/);
});

test("duplicate capability detection groups normalized names", () => {
  assert.deepEqual(duplicateCapabilityGroups([
    { rank: 1, id: "one", name: "Messages Ops" },
    { rank: 2, id: "two", name: "messages-ops" },
    { rank: 3, id: "three", name: "Calendar" },
  ]), [[
    { rank: 1, id: "one", name: "Messages Ops" },
    { rank: 2, id: "two", name: "messages-ops" },
  ]]);
});

test("evaluation summary separates positive relevance from abstention", () => {
  const querySet = validateEvaluationSet({
    schemaVersion: 1,
    queries: [
      { id: "one", category: "direct", query: "one", intent: "one" },
      { id: "two", category: "paraphrase", query: "two", intent: "two" },
      { id: "three", category: "abstain", query: "three", intent: "three" },
      { id: "four", category: "abstain", query: "four", intent: "four" },
    ],
  });
  const response = (names, action = "search") => ({
    decision: { action },
    results: names.map((name, index) => ({ rank: index + 1, id: `${name}-${index}`, name })),
  });
  const summary = summarizeEvaluation(querySet, [
    {
      id: "one",
      response: response(["Same", "same", "other"]),
      judgment: { action: "record", relevantRanks: [1] },
    },
    {
      id: "two",
      response: response(["a", "b", "c"]),
      judgment: { action: "record", relevantRanks: [] },
    },
    {
      id: "three",
      response: response([], "abstain"),
      judgment: { action: "record", relevantRanks: [] },
    },
  ]);
  assert.deepEqual(summary, {
    totalQueries: 4,
    completed: 3,
    skipped: 0,
    remaining: 1,
    positive: { completed: 2, hitRate: 0.5, precision: 0.1667, searchRate: 1 },
    abstain: { completed: 1, noRelevantRate: 1, suppressionRate: 1 },
    duplicateQueries: 1,
  });
});

test("the default evaluation set has ten queries per category", async () => {
  const querySetPath = fileURLToPath(new URL("./evaluation-queries.json", import.meta.url));
  const querySet = validateEvaluationSet(JSON.parse(await fs.readFile(querySetPath, "utf8")));
  const counts = querySet.queries.reduce((result, query) => {
    result[query.category] = (result[query.category] ?? 0) + 1;
    return result;
  }, {});
  assert.equal(querySet.queries.length, 30);
  assert.equal(counts.direct, 10);
  assert.equal(counts.paraphrase, 10);
  assert.equal(counts.abstain, 10);
});
