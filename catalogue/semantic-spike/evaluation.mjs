export function validateEvaluationSet(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.queries)) {
    throw new Error("Expected an evaluation query set with schemaVersion 1 and a queries array.");
  }
  const ids = new Set();
  for (const query of value.queries) {
    if (!query?.id || typeof query.id !== "string") throw new Error("Every evaluation query needs an ID.");
    if (ids.has(query.id)) throw new Error(`Duplicate evaluation query ID: ${query.id}.`);
    if (!["direct", "paraphrase", "abstain"].includes(query.category)) {
      throw new Error(`Unsupported evaluation category for ${query.id}: ${query.category}.`);
    }
    if (!query.query || typeof query.query !== "string") throw new Error(`Evaluation query ${query.id} needs text.`);
    if (!query.intent || typeof query.intent !== "string") throw new Error(`Evaluation query ${query.id} needs an intent.`);
    ids.add(query.id);
  }
  return value;
}

export function parseJudgment(input, maxRank) {
  const value = String(input ?? "").trim().toLowerCase();
  if (["q", "quit"].includes(value)) return { action: "quit" };
  if (["s", "skip"].includes(value)) return { action: "skip" };
  if (["n", "none"].includes(value)) return { action: "record", relevantRanks: [] };
  if (!/^\d+(\s*,\s*\d+)*$/.test(value)) {
    throw new Error("Enter result numbers such as 1 or 1,3; use n, s, or q for none, skip, or quit.");
  }
  const ranks = [...new Set(value.split(",").map((rank) => Number(rank.trim())))].sort((a, b) => a - b);
  if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1 || rank > maxRank)) {
    throw new Error(`Relevant ranks must be between 1 and ${maxRank}.`);
  }
  return { action: "record", relevantRanks: ranks };
}

export function duplicateCapabilityGroups(results) {
  const groups = new Map();
  for (const result of results) {
    const key = normalize(result.name);
    const group = groups.get(key) ?? [];
    group.push({ rank: result.rank, id: result.id, name: result.name });
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

export function summarizeEvaluation(querySet, entries) {
  const queryById = new Map(querySet.queries.map((query) => [query.id, query]));
  const completed = entries.filter((entry) => entry.judgment?.action === "record");
  const skipped = entries.filter((entry) => entry.judgment?.action === "skip");
  const positive = completed.filter((entry) => queryById.get(entry.id)?.category !== "abstain");
  const abstain = completed.filter((entry) => queryById.get(entry.id)?.category === "abstain");
  const positiveRelevant = positive.reduce((sum, entry) => sum + entry.judgment.relevantRanks.length, 0);
  const positiveShown = positive.reduce((sum, entry) => sum + entry.response.results.length, 0);
  const duplicateQueries = completed.filter((entry) => duplicateCapabilityGroups(entry.response.results).length > 0).length;
  return {
    totalQueries: querySet.queries.length,
    completed: completed.length,
    skipped: skipped.length,
    remaining: querySet.queries.length - entries.length,
    positive: {
      completed: positive.length,
      hitRate: ratio(positive.filter((entry) => entry.judgment.relevantRanks.length > 0).length, positive.length),
      precision: ratio(positiveRelevant, positiveShown),
      searchRate: ratio(positive.filter((entry) => entry.response.decision?.action !== "abstain").length, positive.length),
    },
    abstain: {
      completed: abstain.length,
      noRelevantRate: ratio(abstain.filter((entry) => entry.judgment.relevantRanks.length === 0).length, abstain.length),
      suppressionRate: ratio(abstain.filter((entry) => entry.response.decision?.action === "abstain").length, abstain.length),
    },
    duplicateQueries,
  };
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}
