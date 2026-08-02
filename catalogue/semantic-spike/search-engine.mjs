import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import {
  computeInt8Centroid,
  dotProduct,
  fuseSearchResults,
  lexicalSearch,
  loadCatalogue,
  searchInt8,
  validateIndexMetadata,
} from "./lib.mjs";
import {
  applyConfidencePolicy,
  capabilityRowsByName,
  classifyDiscoveryIntent,
  deduplicateCapabilities,
  lexicalFusionPolicy,
  prepareSemanticQuery,
  rerankSemanticResults,
} from "./retrieval-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogueRoot = path.resolve(here, "../..");

export async function createSearchEngine(input = {}) {
  const initializationStartedAt = performance.now();
  const options = normalizeEngineOptions(input);
  const catalogueStartedAt = performance.now();
  const models = await readJson(path.join(here, "models.json"));
  const selectedModel = models[options.model];
  if (!selectedModel) {
    throw new Error(`Unknown model ${options.model}. Expected one of: ${Object.keys(models).join(", ")}.`);
  }

  const catalogue = await loadCatalogue(
    path.join(catalogueRoot, "catalogue-data.json"),
    path.join(catalogueRoot, "catalogue-vercel-index.json"),
  );
  const catalogueLoadMs = performance.now() - catalogueStartedAt;
  const allCapabilityRows = capabilityRowsByName(catalogue.records);
  let extractor = null;
  let indexMetadata = null;
  let index = null;
  let indexContentSha256 = null;
  let corpusCentroid = null;
  let indexLoadMs = 0;
  let centroidMs = 0;
  let modelLoadMs = 0;

  if (options.mode !== "lexical") {
    const indexStartedAt = performance.now();
    const loadedIndex = await loadCompatibleIndex(catalogue, selectedModel, options);
    indexLoadMs = performance.now() - indexStartedAt;
    indexMetadata = loadedIndex.metadata;
    index = loadedIndex.index;
    indexContentSha256 = loadedIndex.contentSha256;
    const centroidStartedAt = performance.now();
    corpusCentroid = computeInt8Centroid(index, selectedModel.dimensions);
    centroidMs = performance.now() - centroidStartedAt;
    options.onProgress(`Loading ${selectedModel.id} from the local model cache...`);
    const modelStartedAt = performance.now();
    extractor = await pipeline("feature-extraction", selectedModel.id, {
      revision: selectedModel.revision,
      dtype: selectedModel.dtype,
      device: "cpu",
      cache_dir: path.join(here, "var", "model-cache"),
      local_files_only: options.offline,
      session_options: {
        intraOpNumThreads: options.threads,
        interOpNumThreads: 1,
      },
    });
    modelLoadMs = performance.now() - modelStartedAt;
  }

  const initializationTimingsMs = {
    total: round(performance.now() - initializationStartedAt),
    catalogueLoad: round(catalogueLoadMs),
    indexLoad: round(indexLoadMs),
    centroid: round(centroidMs),
    modelLoad: round(modelLoadMs),
  };

  return {
    mode: options.mode,
    model: extractor ? publicModel(selectedModel) : null,
    index: indexMetadata ? publicIndex(indexMetadata, indexContentSha256) : null,
    initializationTimingsMs,
    async search(queryInput, searchOptions = {}) {
      const query = String(queryInput ?? "").trim();
      if (!query) throw new Error("Provide an English search query.");
      const limit = positiveInteger(searchOptions.limit ?? options.limit, "limit");
      const diagnosticLimit = nonNegativeInteger(searchOptions.diagnosticLimit ?? 0, "diagnosticLimit");
      const startedAt = performance.now();
      let decision = classifyDiscoveryIntent(query);
      if (decision.action === "abstain") {
        return createAbstentionResponse(query, {
          mode: options.mode,
          offline: options.offline,
          model: extractor ? publicModel(selectedModel) : null,
          index: indexMetadata ? publicIndex(indexMetadata, indexContentSha256) : null,
          initializationTimingsMs,
          decision,
          queryTotalMs: performance.now() - startedAt,
        });
      }
      const retrievalLimit = Math.max(candidateLimit(limit), diagnosticLimit);
      const fusionPolicy = lexicalFusionPolicy(query, { capabilityNames: allCapabilityRows });
      const preparedQuery = prepareSemanticQuery(query);

      const lexicalStartedAt = performance.now();
      const lexicalResults = options.mode === "semantic"
        || (options.mode === "hybrid" && fusionPolicy.lexicalWeight === 0 && !fusionPolicy.allowLexicalOnly)
        ? []
        : lexicalSearch(catalogue.records, query, retrievalLimit);
      const lexicalMs = performance.now() - lexicalStartedAt;

      let semanticResults = [];
      let backgroundSimilarity = null;
      let queryEmbeddingMs = 0;
      let semanticSearchMs = 0;
      if (extractor) {
        const queryStartedAt = performance.now();
        const tensor = await extractor(`${selectedModel.queryPrefix}${preparedQuery.embeddingText}`, {
          pooling: selectedModel.pooling,
          normalize: selectedModel.normalize ?? true,
        });
        queryEmbeddingMs = performance.now() - queryStartedAt;
        const queryVector = Float32Array.from(tensor.data);
        if (queryVector.length !== selectedModel.dimensions) {
          throw new Error(`Expected a ${selectedModel.dimensions}-dimensional query, received ${queryVector.length}.`);
        }
        backgroundSimilarity = dotProduct(queryVector, corpusCentroid);

        const searchStartedAt = performance.now();
        semanticResults = searchInt8(
          index,
          selectedModel.dimensions,
          queryVector,
          retrievalLimit,
        );
        semanticResults = rerankSemanticResults(semanticResults, catalogue.records, preparedQuery.intent);
        semanticSearchMs = performance.now() - searchStartedAt;
      }

      const confidence = describeConfidence(semanticResults, backgroundSimilarity);
      decision = applyConfidencePolicy(decision, confidence, options.confidenceThreshold);
      const ranked = rankResults(options.mode, semanticResults, lexicalResults, retrievalLimit, fusionPolicy);
      const deduplicated = deduplicateCapabilities(decision.action === "abstain" ? [] : ranked, catalogue.records, {
        limit,
        similarity: index
          ? (firstRow, secondRow) => int8RowCosine(index, selectedModel.dimensions, firstRow, secondRow)
          : undefined,
        allRowsByName: allCapabilityRows,
      });
      const results = deduplicated.results.map((result, resultIndex) => describeResult(
        result,
        catalogue.records,
        semanticResults,
        lexicalResults,
        resultIndex + 1,
        backgroundSimilarity,
      ));
      const diagnosticCandidates = diagnosticLimit > 0
        ? ranked.slice(0, diagnosticLimit).map((result, resultIndex) => describeCandidate(
          result,
          catalogue.records,
          semanticResults,
          lexicalResults,
          resultIndex + 1,
          false,
          backgroundSimilarity,
        ))
        : [];
      const queryTotalMs = performance.now() - startedAt;
      return {
        schemaVersion: 1,
        query,
        mode: options.mode,
        offline: options.offline,
        decision,
        model: extractor ? publicModel(selectedModel) : null,
        index: indexMetadata ? publicIndex(indexMetadata, indexContentSha256) : null,
        initializationTimingsMs,
        timingsMs: {
          queryTotal: round(queryTotalMs),
          queryEmbedding: round(queryEmbeddingMs),
          semanticSearch: round(semanticSearchMs),
          lexicalSearch: round(lexicalMs),
        },
        retrievalPolicy: {
          fusion: fusionPolicy,
          semanticIntent: preparedQuery.intent,
          confidenceThreshold: options.confidenceThreshold,
          deduplication: {
            collapsed: deduplicated.collapsed,
            similarityThreshold: deduplicated.similarityThreshold,
          },
        },
        confidence,
        diagnostics: {
          candidateCount: diagnosticCandidates.length,
          candidates: diagnosticCandidates,
        },
        results,
      };
    },
  };
}

async function loadCompatibleIndex(catalogue, model, options) {
  const indexDir = options.index
    ? path.resolve(process.cwd(), options.index)
    : await findCompatibleIndex(catalogue, model, options.model, options.threads);
  const metadata = await readJson(path.join(indexDir, "metadata.json"));
  validateIndexMetadata(metadata, catalogue, model);

  const [idsBuffer, vectorBuffer, normBuffer] = await Promise.all([
    fs.readFile(path.join(indexDir, metadata.files.ids)),
    fs.readFile(path.join(indexDir, metadata.files.vectors)),
    fs.readFile(path.join(indexDir, metadata.files.norms)),
  ]);
  const ids = JSON.parse(idsBuffer.toString("utf8"));
  if (ids.length !== metadata.count) throw new Error(`Index ID count mismatch: ${ids.length} != ${metadata.count}.`);
  if (vectorBuffer.byteLength !== metadata.count * metadata.dimensions) {
    throw new Error(`Index vector size mismatch: ${vectorBuffer.byteLength} bytes.`);
  }
  if (normBuffer.byteLength !== metadata.count * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`Index norm size mismatch: ${normBuffer.byteLength} bytes.`);
  }

  const mismatchedRow = ids.findIndex((id, row) => catalogue.records[row]?.id !== id);
  if (mismatchedRow !== -1) {
    throw new Error(
      `Index row ${mismatchedRow} references ${ids[mismatchedRow]}; `
      + `catalogue row references ${catalogue.records[mismatchedRow]?.id ?? "nothing"}.`,
    );
  }

  return {
    metadata,
    contentSha256: {
      ids: sha256(idsBuffer),
      vectors: sha256(vectorBuffer),
      norms: sha256(normBuffer),
    },
    index: {
      values: new Int8Array(vectorBuffer.buffer, vectorBuffer.byteOffset, vectorBuffer.byteLength),
      norms: new Float32Array(normBuffer.buffer.slice(
        normBuffer.byteOffset,
        normBuffer.byteOffset + normBuffer.byteLength,
      )),
    },
  };
}

async function findCompatibleIndex(catalogue, model, modelKey, threads) {
  const modelDir = path.join(here, "var", modelKey);
  const entries = await fs.readdir(modelDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .sort((a, b) => Number(b.name) - Number(a.name));
  for (const candidate of candidates) {
    const indexDir = path.join(modelDir, candidate.name);
    try {
      const metadata = await readJson(path.join(indexDir, "metadata.json"));
      validateIndexMetadata(metadata, catalogue, model);
      return indexDir;
    } catch {
      // Keep looking for an index built from the current catalogue and model revision.
    }
  }
  throw new Error(
    `No compatible ${modelKey} index found. `
    + `Build one with: npm run benchmark -- --model ${modelKey} --limit 0 --threads ${threads}`,
  );
}

function normalizeEngineOptions(input) {
  const options = {
    mode: input.mode ?? "hybrid",
    model: input.model ?? "gte",
    index: input.index ?? null,
    limit: positiveInteger(input.limit ?? 3, "limit"),
    threads: positiveInteger(input.threads ?? 4, "threads"),
    offline: input.offline ?? false,
    confidenceThreshold: nonNegativeNumber(input.confidenceThreshold ?? 0.0725, "confidenceThreshold"),
    onProgress: input.onProgress ?? (() => {}),
  };
  if (!["lexical", "semantic", "hybrid"].includes(options.mode)) {
    throw new Error(`Expected mode lexical, semantic, or hybrid; received: ${options.mode}.`);
  }
  if (typeof options.onProgress !== "function") throw new Error("Expected onProgress to be a function.");
  return options;
}

function publicModel(model) {
  return {
    id: model.id,
    revision: model.revision,
    dimensions: model.dimensions,
    dtype: model.dtype,
    pooling: model.pooling,
    normalize: model.normalize ?? true,
    queryPrefix: model.queryPrefix ?? "",
    documentPrefix: model.documentPrefix ?? "",
  };
}

function publicIndex(metadata, contentSha256) {
  return {
    count: metadata.count,
    catalogue: metadata.catalogue,
    vectorFormat: metadata.vectorFormat,
    normFormat: metadata.normFormat,
    textSchemaVersion: metadata.textSchemaVersion,
    createdAt: metadata.createdAt,
    contentSha256,
  };
}

function rankResults(mode, semanticResults, lexicalResults, limit, fusionPolicy) {
  if (mode === "semantic") return semanticResults.slice(0, limit);
  if (mode === "lexical") return lexicalResults.slice(0, limit);
  return fuseSearchResults(semanticResults, lexicalResults, limit, fusionPolicy);
}

function describeResult(result, records, semanticResults, lexicalResults, rank, backgroundSimilarity) {
  const described = describeCandidate(
    result,
    records,
    semanticResults,
    lexicalResults,
    rank,
    true,
    backgroundSimilarity,
  );
  described.alternates = (result.alternates ?? []).map((alternate) => describeCandidate(
    alternate,
    records,
    semanticResults,
    lexicalResults,
    null,
    alternate.relation === "variant",
    backgroundSimilarity,
  ));
  return described;
}

function describeCandidate(
  result,
  records,
  semanticResults,
  lexicalResults,
  rank,
  includeDescription,
  backgroundSimilarity,
) {
  const record = records[result.row];
  const semanticIndex = semanticResults.findIndex((candidate) => candidate.row === result.row);
  const lexicalIndex = lexicalResults.findIndex((candidate) => candidate.row === result.row);
  return {
    ...(rank === null ? {} : { rank }),
    ...(result.relation ? { relation: result.relation } : {}),
    id: record.id,
    name: record.name,
    ...(includeDescription ? { description: record.description } : {}),
    type: record.type,
    ecosystem: record.ecosystem,
    semantic: semanticIndex === -1 ? null : {
      rank: semanticIndex + 1,
      score: round(semanticResults[semanticIndex].score, 6),
      centeredScore: round(semanticResults[semanticIndex].score - backgroundSimilarity, 6),
    },
    lexical: lexicalIndex === -1 ? null : {
      rank: lexicalIndex + 1,
      score: round(lexicalResults[lexicalIndex].score, 6),
    },
    score: Number.isFinite(result.score) ? round(result.score, 8) : null,
  };
}

function describeConfidence(semanticResults, backgroundSimilarity) {
  if (semanticResults.length === 0 || backgroundSimilarity === null) return null;
  const topScore = semanticResults[0].score;
  const nextScore = semanticResults[1]?.score ?? topScore;
  return {
    backgroundSimilarity: round(backgroundSimilarity, 6),
    topSemanticScore: round(topScore, 6),
    topCenteredScore: round(topScore - backgroundSimilarity, 6),
    topSemanticGap: round(topScore - nextScore, 6),
  };
}

function int8RowCosine(index, dimensions, firstRow, secondRow) {
  const firstOffset = firstRow * dimensions;
  const secondOffset = secondRow * dimensions;
  let dot = 0;
  for (let column = 0; column < dimensions; column += 1) {
    dot += index.values[firstOffset + column] * index.values[secondOffset + column];
  }
  const denominator = index.norms[firstRow] * index.norms[secondRow];
  return denominator > 0 ? dot / denominator : 0;
}

export function createAbstentionResponse(queryInput, input = {}) {
  const query = String(queryInput ?? "").trim();
  const decision = input.decision ?? classifyDiscoveryIntent(query);
  return {
    schemaVersion: 1,
    query,
    mode: input.mode ?? "hybrid",
    offline: input.offline ?? false,
    decision,
    model: input.model ?? null,
    index: input.index ?? null,
    initializationTimingsMs: input.initializationTimingsMs ?? null,
    timingsMs: {
      queryTotal: round(input.queryTotalMs ?? 0),
      queryEmbedding: 0,
      semanticSearch: 0,
      lexicalSearch: 0,
    },
    retrievalPolicy: null,
    confidence: null,
    diagnostics: {
      candidateCount: 0,
      candidates: [],
    },
    results: [],
  };
}

function candidateLimit(limit) {
  return Math.max(100, limit * 20);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected ${label} to be a positive integer, received: ${value}.`);
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected ${label} to be a non-negative integer, received: ${value}.`);
  }
  return parsed;
}

function nonNegativeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected ${label} to be a non-negative number, received: ${value}.`);
  }
  return parsed;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
