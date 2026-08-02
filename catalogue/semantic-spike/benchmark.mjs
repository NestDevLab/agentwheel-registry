import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import {
  catalogueText,
  expectedRank,
  lexicalSearch,
  loadCatalogue,
  percentile,
  quantizeVectors,
  retrievalMetrics,
  searchFloat,
  searchInt8,
  selectCorpus,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogueRoot = path.resolve(here, "../..");
const options = parseArgs(process.argv.slice(2));
const models = await readJson(path.join(here, "models.json"));
const queries = await readJson(path.join(here, "queries.json"));
const model = models[options.model];
if (!model) throw new Error(`Unknown model ${options.model}. Expected one of: ${Object.keys(models).join(", ")}.`);

const catalogue = await loadCatalogue(
  path.join(catalogueRoot, "catalogue-data.json"),
  path.join(catalogueRoot, "catalogue-vercel-index.json"),
);
const requiredIds = queries.flatMap((query) => query.expectedIds);
const records = selectCorpus(catalogue.records, options.limit, requiredIds);
const outputDir = path.join(here, "var", options.model, String(records.length));
await fs.mkdir(outputDir, { recursive: true });

console.log(`Model: ${model.id}@${model.revision}`);
console.log(`Corpus: ${records.length} of ${catalogue.records.length} catalogue records`);
console.log(`Runtime: Node ${options.device}, ${options.threads} threads, ${model.dtype}, ${model.pooling} pooling, normalized embeddings`);

const modelStart = performance.now();
const extractor = await pipeline("feature-extraction", model.id, {
  revision: model.revision,
  dtype: model.dtype,
  device: options.device,
  cache_dir: path.join(here, "var", "model-cache"),
  session_options: {
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
  },
});
const modelLoadMs = performance.now() - modelStart;

const embeddingsStart = performance.now();
const vectors = await embedCorpus(extractor, records, model, options.batchSize);
const corpusEmbeddingMs = performance.now() - embeddingsStart;
if (vectors.length !== records.length * model.dimensions) {
  throw new Error(`Expected ${records.length * model.dimensions} values, received ${vectors.length}.`);
}

const quantizeStart = performance.now();
const quantized = quantizeVectors(vectors, model.dimensions);
const quantizeMs = performance.now() - quantizeStart;
await writeIndex(outputDir, records, quantized, model, catalogue.sources, {
  modelLoadMs,
  corpusEmbeddingMs,
  quantizeMs,
});

const evaluation = [];
const queryEmbeddingTimes = [];
const floatSearchTimes = [];
const int8SearchTimes = [];
for (const query of queries) {
  const queryStart = performance.now();
  const queryTensor = await extractor(`${model.queryPrefix}${query.query}`, {
    pooling: model.pooling,
    normalize: true,
  });
  queryEmbeddingTimes.push(performance.now() - queryStart);
  const queryVector = Float32Array.from(queryTensor.data);

  const floatStart = performance.now();
  const floatResults = searchFloat(vectors, model.dimensions, queryVector, options.topK);
  floatSearchTimes.push(performance.now() - floatStart);

  const int8Start = performance.now();
  const int8Results = searchInt8(quantized, model.dimensions, queryVector, options.topK);
  int8SearchTimes.push(performance.now() - int8Start);

  const lexicalResults = lexicalSearch(records, query.query, options.topK);
  evaluation.push({
    id: query.id,
    query: query.query,
    expectedIds: query.expectedIds,
    floatRank: expectedRank(floatResults, records, query.expectedIds),
    int8Rank: expectedRank(int8Results, records, query.expectedIds),
    lexicalRank: expectedRank(lexicalResults, records, query.expectedIds),
    int8Top10Overlap: overlap(floatResults, int8Results),
    floatTop: describe(floatResults, records),
    int8Top: describe(int8Results, records),
    lexicalTop: describe(lexicalResults, records),
  });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  model,
  runtime: {
    device: options.device,
    threads: options.threads,
    library: "@huggingface/transformers@4.2.0",
  },
  corpus: {
    selected: records.length,
    available: catalogue.records.length,
    sources: catalogue.sources,
  },
  timingsMs: {
    modelLoad: round(modelLoadMs),
    corpusEmbedding: round(corpusEmbeddingMs),
    corpusPerRecord: round(corpusEmbeddingMs / records.length),
    quantize: round(quantizeMs),
    queryEmbeddingP50: round(percentile(queryEmbeddingTimes, 0.5)),
    queryEmbeddingP95: round(percentile(queryEmbeddingTimes, 0.95)),
    floatSearchP50: round(percentile(floatSearchTimes, 0.5)),
    floatSearchP95: round(percentile(floatSearchTimes, 0.95)),
    int8SearchP50: round(percentile(int8SearchTimes, 0.5)),
    int8SearchP95: round(percentile(int8SearchTimes, 0.95)),
  },
  metrics: {
    float: retrievalMetrics(evaluation.map((item) => item.floatRank)),
    int8: retrievalMetrics(evaluation.map((item) => item.int8Rank)),
    lexical: retrievalMetrics(evaluation.map((item) => item.lexicalRank)),
    averageInt8Top10Overlap: round(evaluation.reduce((sum, item) => sum + item.int8Top10Overlap, 0) / evaluation.length),
  },
  evaluation,
};

await fs.writeFile(path.join(outputDir, "benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
console.table(evaluation.map((item) => ({
  query: item.id,
  float: item.floatRank ?? "-",
  int8: item.int8Rank ?? "-",
  lexical: item.lexicalRank ?? "-",
  top: item.int8Top[0]?.name ?? "-",
})));
console.log(JSON.stringify({ timingsMs: report.timingsMs, metrics: report.metrics }, null, 2));
console.log(`Report: ${path.join(outputDir, "benchmark.json")}`);

async function embedCorpus(extractor, records, selectedModel, batchSize) {
  const values = new Float32Array(records.length * selectedModel.dimensions);
  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    const tensor = await extractor(batch.map((record) => `${selectedModel.documentPrefix ?? ""}${catalogueText(record)}`), {
      pooling: selectedModel.pooling,
      normalize: selectedModel.normalize ?? true,
    });
    values.set(tensor.data, start * selectedModel.dimensions);
    const completed = Math.min(records.length, start + batch.length);
    if (completed === records.length || completed % Math.max(batchSize, 256) === 0) {
      console.log(`Embedded ${completed}/${records.length}`);
    }
  }
  return values;
}

async function writeIndex(outputDir, records, index, selectedModel, sources, timings) {
  const ids = `${JSON.stringify(records.map(({ id }) => id))}\n`;
  const metadata = {
    schemaVersion: 1,
    textSchemaVersion: 1,
    createdAt: new Date().toISOString(),
    model: selectedModel,
    catalogue: sources,
    count: records.length,
    dimensions: selectedModel.dimensions,
    vectorFormat: "signed-int8-per-vector-scaled",
    normFormat: "float32-little-endian",
    files: {
      ids: "ids.json",
      vectors: "vectors.int8.bin",
      norms: "norms.f32.bin",
    },
    timingsMs: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, round(value)])),
  };
  await Promise.all([
    fs.writeFile(path.join(outputDir, "ids.json"), ids),
    fs.writeFile(path.join(outputDir, "vectors.int8.bin"), Buffer.from(index.values.buffer)),
    fs.writeFile(path.join(outputDir, "norms.f32.bin"), Buffer.from(index.norms.buffer)),
    fs.writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`),
  ]);
}

function describe(results, records) {
  return results.map(({ row, score }) => ({
    id: records[row].id,
    name: records[row].name,
    score: round(score, 6),
  }));
}

function overlap(first, second) {
  const rows = new Set(first.map(({ row }) => row));
  return second.filter(({ row }) => rows.has(row)).length / Math.max(first.length, 1);
}

function parseArgs(args) {
  const result = { model: "minilm", limit: 4000, batchSize: 32, topK: 10, device: "cpu", threads: 4 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--model") result.model = args[++index];
    else if (argument === "--limit") result.limit = positiveInteger(args[++index], "limit", true);
    else if (argument === "--batch-size") result.batchSize = positiveInteger(args[++index], "batch size");
    else if (argument === "--top-k") result.topK = positiveInteger(args[++index], "top k");
    else if (argument === "--device") result.device = args[++index];
    else if (argument === "--threads") result.threads = positiveInteger(args[++index], "threads");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["cpu", "webgpu", "cuda"].includes(result.device)) {
    throw new Error(`Expected device to be cpu, webgpu, or cuda, received: ${result.device}`);
  }
  return result;
}

function positiveInteger(value, label, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`Expected ${label} to be ${allowZero ? "a non-negative" : "a positive"} integer, received: ${value}`);
  }
  return parsed;
}

function round(value, digits = 2) {
  if (value === null || value === undefined) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
