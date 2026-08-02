import crypto from "node:crypto";
import fs from "node:fs/promises";

export async function loadCatalogue(enrichedPath, vercelPath) {
  const [enriched, vercel] = await Promise.all([
    readJson(enrichedPath),
    readJson(vercelPath),
  ]);
  const records = new Map();

  for (const entry of enriched.entries ?? []) {
    records.set(entry.id, {
      id: entry.id,
      name: entry.name ?? "",
      description: entry.description ?? "",
      type: entry.type ?? "package",
      ecosystem: entry.ecosystem ?? "unknown",
      tags: stringArray(entry.tags),
      provides: stringArray(entry.provides),
    });
  }

  for (const entry of vercel.entries ?? []) {
    const id = `vercel:${entry.o}/${entry.r}/${entry.s}`;
    const existing = records.get(id);
    if (existing) {
      if (!existing.description && entry.d) existing.description = entry.d;
      continue;
    }
    records.set(id, {
      id,
      name: entry.s ?? "",
      description: entry.d ?? "",
      type: "skill",
      ecosystem: "vercel",
      tags: [],
      provides: ["skills"],
    });
  }

  return {
    records: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sources: {
      enriched: {
        schemaVersion: enriched.schemaVersion,
        generatedAt: enriched.generatedAt,
        sha256: await sha256File(enrichedPath),
      },
      vercel: {
        schemaVersion: vercel.schemaVersion,
        generatedAt: vercel.generatedAt,
        sha256: await sha256File(vercelPath),
      },
    },
  };
}

export function catalogueText(record) {
  return [
    record.name,
    record.description,
    record.tags.join(" "),
    record.provides.join(" "),
    record.type,
    record.ecosystem,
  ].filter(Boolean).join(". ").slice(0, 2400);
}

export function selectCorpus(records, limit, requiredIds = []) {
  if (!limit || limit >= records.length) return [...records];
  const required = new Set(requiredIds);
  const selected = records.filter((record) => required.has(record.id));
  const remaining = records
    .filter((record) => !required.has(record.id))
    .map((record) => ({ record, hash: stableHash(record.id) }))
    .sort((a, b) => a.hash - b.hash || a.record.id.localeCompare(b.record.id))
    .slice(0, Math.max(0, limit - selected.length))
    .map(({ record }) => record);
  return [...selected, ...remaining].sort((a, b) => a.id.localeCompare(b.id));
}

export function quantizeVectors(vectors, dimensions) {
  if (vectors.length % dimensions !== 0) {
    throw new Error(`Vector length ${vectors.length} is not divisible by ${dimensions}.`);
  }
  const count = vectors.length / dimensions;
  const values = new Int8Array(vectors.length);
  const norms = new Float32Array(count);

  for (let row = 0; row < count; row += 1) {
    const offset = row * dimensions;
    let maxAbs = 0;
    for (let column = 0; column < dimensions; column += 1) {
      maxAbs = Math.max(maxAbs, Math.abs(vectors[offset + column]));
    }
    const multiplier = maxAbs > 0 ? 127 / maxAbs : 0;
    let squaredNorm = 0;
    for (let column = 0; column < dimensions; column += 1) {
      const value = Math.max(-127, Math.min(127, Math.round(vectors[offset + column] * multiplier)));
      values[offset + column] = value;
      squaredNorm += value * value;
    }
    norms[row] = Math.sqrt(squaredNorm);
  }

  return { values, norms };
}

export function searchFloat(vectors, dimensions, query, limit = 10) {
  const count = vectors.length / dimensions;
  const results = [];
  for (let row = 0; row < count; row += 1) {
    const offset = row * dimensions;
    let score = 0;
    for (let column = 0; column < dimensions; column += 1) {
      score += vectors[offset + column] * query[column];
    }
    insertTop(results, { row, score }, limit);
  }
  return results;
}

export function searchInt8(index, dimensions, query, limit = 10) {
  const count = index.values.length / dimensions;
  const results = [];
  for (let row = 0; row < count; row += 1) {
    const offset = row * dimensions;
    let dot = 0;
    for (let column = 0; column < dimensions; column += 1) {
      dot += index.values[offset + column] * query[column];
    }
    const score = index.norms[row] > 0 ? dot / index.norms[row] : 0;
    insertTop(results, { row, score }, limit);
  }
  return results;
}

export function computeInt8Centroid(index, dimensions) {
  if (index.values.length % dimensions !== 0) {
    throw new Error(`Index vector length ${index.values.length} is not divisible by ${dimensions}.`);
  }
  const count = index.values.length / dimensions;
  const centroid = new Float32Array(dimensions);
  for (let row = 0; row < count; row += 1) {
    const norm = index.norms[row];
    if (norm <= 0) continue;
    const offset = row * dimensions;
    for (let column = 0; column < dimensions; column += 1) {
      centroid[column] += index.values[offset + column] / norm;
    }
  }
  if (count > 0) {
    for (let column = 0; column < dimensions; column += 1) centroid[column] /= count;
  }
  return centroid;
}

export function dotProduct(first, second) {
  if (first.length !== second.length) {
    throw new Error(`Vector length mismatch: ${first.length} != ${second.length}.`);
  }
  let result = 0;
  for (let index = 0; index < first.length; index += 1) result += first[index] * second[index];
  return result;
}

export function lexicalSearch(records, query, limit = 10) {
  const normalizedQuery = normalize(query);
  const tokens = unique(normalizedQuery.split(" ").filter(Boolean));
  return records
    .map((record, row) => ({ row, score: lexicalScore(record, normalizedQuery, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || records[a.row].id.localeCompare(records[b.row].id))
    .slice(0, limit);
}

export function fuseSearchResults(semanticResults, lexicalResults, limit = 10, input = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Expected a positive result limit, received: ${limit}`);
  const options = typeof input === "number"
    ? { rankConstant: input }
    : input;
  const rankConstant = options.rankConstant ?? 60;
  const semanticWeight = options.semanticWeight ?? 1;
  const lexicalWeight = options.lexicalWeight ?? 1;
  const allowLexicalOnly = options.allowLexicalOnly ?? true;
  const maxLexicalBoostSemanticRank = options.maxLexicalBoostSemanticRank ?? null;
  if (!Number.isFinite(rankConstant) || rankConstant < 0) {
    throw new Error(`Expected a non-negative rank constant, received: ${rankConstant}`);
  }
  if (!Number.isFinite(semanticWeight) || semanticWeight < 0) {
    throw new Error(`Expected a non-negative semantic weight, received: ${semanticWeight}`);
  }
  if (!Number.isFinite(lexicalWeight) || lexicalWeight < 0) {
    throw new Error(`Expected a non-negative lexical weight, received: ${lexicalWeight}`);
  }
  if (maxLexicalBoostSemanticRank !== null
    && (!Number.isInteger(maxLexicalBoostSemanticRank) || maxLexicalBoostSemanticRank < 1)) {
    throw new Error(
      `Expected maxLexicalBoostSemanticRank to be null or a positive integer, received: ${maxLexicalBoostSemanticRank}`,
    );
  }

  const candidates = new Map();
  addRankedResults(candidates, semanticResults, "semantic", rankConstant, semanticWeight, true, null);
  addRankedResults(
    candidates,
    lexicalResults,
    "lexical",
    rankConstant,
    lexicalWeight,
    allowLexicalOnly,
    maxLexicalBoostSemanticRank,
  );
  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.row - b.row)
    .slice(0, limit);
}

export function validateIndexMetadata(metadata, catalogue, model) {
  if (metadata.schemaVersion !== 1) throw new Error(`Unsupported index schema: ${metadata.schemaVersion}.`);
  if (metadata.textSchemaVersion !== 1) {
    throw new Error(`Unsupported index text schema: ${metadata.textSchemaVersion}.`);
  }
  if (metadata.count !== catalogue.records.length) {
    throw new Error(`Index contains ${metadata.count} records; catalogue contains ${catalogue.records.length}.`);
  }
  if (metadata.dimensions !== model.dimensions) throw new Error("Index dimension mismatch.");
  if (metadata.model.dimensions !== model.dimensions) throw new Error("Index model dimension mismatch.");
  if (metadata.vectorFormat !== "signed-int8-per-vector-scaled") {
    throw new Error(`Unsupported index vector format: ${metadata.vectorFormat}.`);
  }
  if (metadata.normFormat !== "float32-little-endian") {
    throw new Error(`Unsupported index norm format: ${metadata.normFormat}.`);
  }
  if (metadata.model.id !== model.id || metadata.model.revision !== model.revision) {
    throw new Error("Index model revision mismatch.");
  }
  if (metadata.model.dtype !== model.dtype) throw new Error("Index model dtype mismatch.");
  if (metadata.model.pooling !== model.pooling) throw new Error("Index model pooling mismatch.");
  if ((metadata.model.normalize ?? true) !== (model.normalize ?? true)) {
    throw new Error("Index model normalization mismatch.");
  }
  if ((metadata.model.queryPrefix ?? "") !== (model.queryPrefix ?? "")
    || (metadata.model.documentPrefix ?? "") !== (model.documentPrefix ?? "")) {
    throw new Error("Index model prefix contract mismatch.");
  }
  for (const [source, sourceMetadata] of Object.entries(catalogue.sources)) {
    if (metadata.catalogue[source]?.sha256 !== sourceMetadata.sha256) {
      throw new Error(`Index catalogue checksum mismatch for ${source}.`);
    }
  }
}

export function expectedRank(results, records, expectedIds) {
  const expected = new Set(expectedIds);
  const index = results.findIndex(({ row }) => expected.has(records[row].id));
  return index === -1 ? null : index + 1;
}

export function retrievalMetrics(ranks) {
  const finite = ranks.filter((rank) => rank !== null);
  return {
    queries: ranks.length,
    hitAt1: ratio(finite.filter((rank) => rank <= 1).length, ranks.length),
    hitAt5: ratio(finite.filter((rank) => rank <= 5).length, ranks.length),
    hitAt10: ratio(finite.filter((rank) => rank <= 10).length, ranks.length),
    mrrAt10: ratio(finite.filter((rank) => rank <= 10).reduce((sum, rank) => sum + (1 / rank), 0), ranks.length),
  };
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function lexicalScore(record, query, tokens) {
  const name = normalize(record.name);
  const description = normalize(record.description);
  const tags = normalize(record.tags.join(" "));
  const provides = normalize(record.provides.join(" "));
  const type = normalize(record.type);
  const ecosystem = normalize(record.ecosystem);
  let score = 0;
  let covered = tokens.length > 0;

  if (name === query) score += 10000;
  else if (name.startsWith(query)) score += 5000;
  else if (name.includes(query)) score += 3000;
  if (tags.includes(query) || provides.includes(query)) score += 2000;
  if (description.includes(query)) score += 1000;
  if (type.includes(query) || ecosystem.includes(query)) score += 800;

  for (const token of tokens) {
    let tokenCovered = false;
    if (hasToken(name, token)) {
      score += 300;
      tokenCovered = true;
    } else if (name.split(" ").some((candidate) => candidate.startsWith(token))) {
      score += 200;
      tokenCovered = true;
    }
    if (hasToken(tags, token) || hasToken(provides, token)) {
      score += 180;
      tokenCovered = true;
    }
    if (hasToken(description, token)) {
      score += 80;
      tokenCovered = true;
    }
    if (hasToken(type, token) || hasToken(ecosystem, token)) {
      score += 60;
      tokenCovered = true;
    }
    covered &&= tokenCovered;
  }
  if (covered) score += 500;
  return score;
}

function insertTop(results, candidate, limit) {
  const index = results.findIndex((result) => candidate.score > result.score);
  if (index === -1) results.push(candidate);
  else results.splice(index, 0, candidate);
  if (results.length > limit) results.length = limit;
}

function addRankedResults(candidates, results, source, rankConstant, weight, allowNew, maxExistingRank) {
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!allowNew && !candidates.has(result.row)) continue;
    const rank = index + 1;
    const candidate = candidates.get(result.row) ?? {
      row: result.row,
      score: 0,
      semanticRank: null,
      semanticScore: null,
      lexicalRank: null,
      lexicalScore: null,
    };
    const existingRank = candidate.semanticRank ?? candidate.lexicalRank;
    if (maxExistingRank === null || existingRank === null || existingRank <= maxExistingRank) {
      candidate.score += weight / (rankConstant + rank);
    }
    candidate[`${source}Rank`] = rank;
    candidate[`${source}Score`] = result.score;
    candidates.set(result.row, candidate);
  }
}

function normalize(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasToken(text, token) {
  return text.split(" ").includes(token);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function unique(values) {
  return [...new Set(values)];
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
