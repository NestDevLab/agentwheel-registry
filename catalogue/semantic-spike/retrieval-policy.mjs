const DETECTOR = "english-conversation-v1";
const SELF_LEARNING_CONTEXT = "Self-improving agent that automatically learns from experience, feedback, corrections, conversations, and completed work. Capture learnings as memory, rules, or reusable skills.";
const SELF_LEARNING_NAME = /\bself (?:improve|improving|improvement|learn|learning)\b/u;
const SELF_LEARNING_DESCRIPTION = /\b(?:self improving|self improvement|self learning|learns? from|learning from|extract a learned skill|continuously evolve|automatic skill evolution)\b/u;

const EXACT_NON_DISCOVERY = new Map([
  ["yes", "acknowledgement"],
  ["yeah", "acknowledgement"],
  ["yep", "acknowledgement"],
  ["no", "acknowledgement"],
  ["nope", "acknowledgement"],
  ["ok", "acknowledgement"],
  ["okay", "acknowledgement"],
  ["sure", "acknowledgement"],
  ["continue", "conversation-control"],
  ["go ahead", "conversation-control"],
  ["proceed", "conversation-control"],
  ["stop", "conversation-control"],
  ["cancel", "conversation-control"],
  ["wait", "conversation-control"],
  ["please wait", "conversation-control"],
  ["hold on", "conversation-control"],
  ["hello", "greeting"],
  ["hi", "greeting"],
  ["hey", "greeting"],
  ["good morning", "greeting"],
  ["good afternoon", "greeting"],
  ["good evening", "greeting"],
  ["good night", "greeting"],
  ["bye", "farewell"],
  ["goodbye", "farewell"],
  ["thanks", "acknowledgement"],
  ["thank you", "acknowledgement"],
  ["tell me something interesting", "small-talk"],
]);

const NON_DISCOVERY_PATTERNS = [
  {
    reason: "acknowledgement",
    pattern: /^(?:thanks|thank you)(?: (?:that|this|it) (?:helped|worked|solved it|fixed it))?$/u,
  },
  {
    reason: "agreement",
    pattern: /^(?:i agree(?: with (?:that|this)(?: plan)?)?|sounds good|that works for me)$/u,
  },
  {
    reason: "conversation-recall",
    pattern: /^(?:what did i ask before|what were we (?:talking|speaking) about|repeat my last (?:question|message))$/u,
  },
  {
    reason: "arithmetic",
    pattern: /^(?:what is|calculate|compute) (?:-?\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten) (?:plus|minus|times|multiplied by|divided by) (?:-?\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)$/u,
  },
];

const REQUEST_LEADS = new Set([
  "audit",
  "bring",
  "build",
  "can",
  "check",
  "configure",
  "could",
  "create",
  "deploy",
  "extract",
  "find",
  "generate",
  "give",
  "help",
  "how",
  "i",
  "let",
  "organize",
  "please",
  "publish",
  "put",
  "review",
  "run",
  "schedule",
  "triage",
  "turn",
  "we",
  "what",
  "which",
]);

export function classifyDiscoveryIntent(queryInput) {
  const query = normalizeEnglish(queryInput);
  const exactReason = EXACT_NON_DISCOVERY.get(query);
  if (exactReason) return abstain(exactReason);
  const matchedRule = NON_DISCOVERY_PATTERNS.find(({ pattern }) => pattern.test(query));
  if (matchedRule) return abstain(matchedRule.reason);
  return {
    action: "search",
    reason: "not-clearly-conversational",
    detector: DETECTOR,
  };
}

export function prepareSemanticQuery(queryInput) {
  const query = String(queryInput ?? "").trim();
  const normalized = normalizeEnglish(query);
  const explicitIntent = SELF_LEARNING_NAME.test(normalized);
  const agentSubject = /\b(?:agent|assistant|ai)\b/u.test(normalized);
  const learningAction = /\b(?:learn|learns|learning|improve|improves|improving|evolve|evolves|evolving|adapt|adapts|adapting)\b/u.test(normalized);
  const autonomousContext = /\b(?:self|itself|own|automatic|automatically|autonomous|continuously|continuous|while|chat|chatting|conversation|feedback|correction|corrections|experience|experiences)\b/u.test(normalized);
  if (!explicitIntent && !(agentSubject && learningAction && autonomousContext)) {
    return { intent: null, embeddingText: query };
  }
  return {
    intent: "self-learning-agent",
    embeddingText: `${query}. ${SELF_LEARNING_CONTEXT}`,
  };
}

export function rerankSemanticResults(results, records, intent) {
  if (intent !== "self-learning-agent") return results;
  return results
    .map((result, index) => ({
      result,
      index,
      rankingScore: result.score + selfLearningBoost(records[result.row]),
    }))
    .sort((first, second) => second.rankingScore - first.rankingScore || first.index - second.index)
    .map(({ result }) => result);
}

export function lexicalFusionPolicy(queryInput, input = {}) {
  const normalizedQuery = normalizeEnglish(queryInput);
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const exactCapabilityName = input.capabilityNames?.has(normalizedQuery) ?? false;
  const exactLookup = exactCapabilityName || (tokens.length > 0
    && (tokens.length === 1 || (tokens.length <= 4 && !REQUEST_LEADS.has(tokens[0]))));
  return {
    semanticWeight: 1,
    lexicalWeight: exactLookup ? 0.75 : 0,
    allowLexicalOnly: exactLookup,
    maxLexicalBoostSemanticRank: null,
    profile: exactLookup ? "short-lookup" : "semantic-natural-language",
  };
}

export function applyConfidencePolicy(decision, confidence, threshold) {
  if (decision.action !== "search" || !confidence || confidence.topCenteredScore >= threshold) return decision;
  return {
    action: "abstain",
    reason: "low-centered-confidence",
    detector: "corpus-centered-v1",
    score: confidence.topCenteredScore,
    threshold,
  };
}

export function deduplicateCapabilities(candidates, records, input = {}) {
  const limit = positiveInteger(input.limit ?? candidates.length, "limit");
  const similarity = input.similarity ?? (() => null);
  const similarityThreshold = input.similarityThreshold ?? 0.94;
  const groups = [];
  let collapsed = 0;

  for (const candidate of candidates) {
    const record = records[candidate.row];
    const matchingGroup = groups.find((group) => sameCapabilityName(
      group.primary,
      candidate,
      records,
    ));
    if (matchingGroup) {
      matchingGroup.alternates.push({
        ...candidate,
        relation: alternateRelation(
          matchingGroup.primary,
          candidate,
          records,
          similarity,
          similarityThreshold,
        ),
      });
      collapsed += 1;
    } else {
      groups.push({ primary: candidate, alternates: [] });
    }
  }

  const selectedGroups = groups.slice(0, limit);
  for (const group of selectedGroups) {
    const rows = input.allRowsByName?.get(normalizeEnglish(records[group.primary.row].name)) ?? [];
    const includedRows = new Set([group.primary.row, ...group.alternates.map(({ row }) => row)]);
    for (const row of rows) {
      if (includedRows.has(row)) continue;
      const alternate = { row };
      group.alternates.push({
        ...alternate,
        relation: alternateRelation(
          group.primary,
          alternate,
          records,
          similarity,
          similarityThreshold,
        ),
      });
      includedRows.add(row);
      collapsed += 1;
    }
  }

  return {
    results: selectedGroups.map(({ primary, alternates }) => ({
      ...primary,
      alternates,
    })),
    collapsed,
    similarityThreshold,
  };
}

export function capabilityRowsByName(records) {
  const rowsByName = new Map();
  for (let row = 0; row < records.length; row += 1) {
    const key = normalizeEnglish(records[row].name);
    if (!key) continue;
    const rows = rowsByName.get(key) ?? [];
    rows.push(row);
    rowsByName.set(key, rows);
  }
  return rowsByName;
}

export function normalizeEnglish(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sameCapabilityName(primary, candidate, records) {
  const primaryRecord = records[primary.row];
  const candidateRecord = records[candidate.row];
  return normalizeEnglish(primaryRecord.name) === normalizeEnglish(candidateRecord.name);
}

function alternateRelation(primary, candidate, records, similarity, threshold) {
  const primaryRecord = records[primary.row];
  const candidateRecord = records[candidate.row];
  const primaryDescription = normalizeEnglish(primaryRecord.description);
  const candidateDescription = normalizeEnglish(candidateRecord.description);
  if (primaryDescription && primaryDescription === candidateDescription) return "mirror";
  const score = similarity(primary.row, candidate.row);
  return Number.isFinite(score) && score >= threshold ? "mirror" : "variant";
}

function abstain(reason) {
  return {
    action: "abstain",
    reason,
    detector: DETECTOR,
  };
}

function selfLearningBoost(record) {
  if (!record) return 0;
  const name = normalizeEnglish(record.name);
  const description = normalizeEnglish(record.description);
  let boost = 0;
  if (SELF_LEARNING_NAME.test(name)) boost += 0.06;
  else if (/\b(?:learner|reflection)\b/u.test(name)) boost += 0.025;
  if (SELF_LEARNING_DESCRIPTION.test(description)) boost += 0.025;
  if (boost > 0 && record.ecosystem === "official") boost += 0.01;
  return boost;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected ${label} to be a positive integer, received: ${value}.`);
  }
  return parsed;
}
