import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  duplicateCapabilityGroups,
  parseJudgment,
  summarizeEvaluation,
  validateEvaluationSet,
} from "./evaluation.mjs";
import { sha256File } from "./lib.mjs";
import { createSearchEngine } from "./search-engine.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const implementationFiles = [
  "evaluate.mjs",
  "evaluation.mjs",
  "lib.mjs",
  "retrieval-policy.mjs",
  "search-engine.mjs",
  "models.json",
  "package.json",
  "package-lock.json",
];
const options = parseArgs(process.argv.slice(2));
let session = options.resume ? await readJson(options.resume) : null;
if (session && session.schemaVersion !== 2) throw new Error(`Unsupported evaluation session schema: ${session.schemaVersion}.`);
const implementation = await implementationIdentity();
if (session && !sameValue(session.implementation, implementation)) {
  throw new Error("The search implementation changed after this session started; start a new session.");
}

const querySetPath = path.resolve(
  options.queries
    ?? session?.querySet.path
    ?? path.join(here, "evaluation-queries.json"),
);
const querySet = validateEvaluationSet(await readJson(querySetPath));
const querySetDigest = await sha256File(querySetPath);
if (session && session.querySet.sha256 !== querySetDigest) {
  throw new Error("The evaluation query set changed after this session started; start a new session.");
}

const engineOptions = session?.engineConfig ?? {
  mode: options.mode,
  model: options.model,
  index: options.index,
  limit: options.limit,
  threads: options.threads,
  offline: options.offline,
  confidenceThreshold: options.confidenceThreshold,
};
const evaluationOptions = session?.evaluationConfig ?? {
  diagnosticLimit: options.diagnosticLimit,
};
const outputPath = path.resolve(
  options.resume
    ?? options.output
    ?? path.join(here, "var", "evaluation", `evaluation-${timestampSlug()}.json`),
);
if (!session && await pathExists(outputPath)) {
  throw new Error(`Evaluation output already exists: ${outputPath}. Use --resume to continue it.`);
}

console.log(`Loading ${engineOptions.mode} search engine once for ${querySet.queries.length} evaluation queries...`);
const engine = await createSearchEngine({
  ...engineOptions,
  onProgress: (message) => console.log(message),
});
const engineIdentity = {
  mode: engine.mode,
  model: engine.model,
  index: engine.index,
};
if (session && !sameValue(session.engineIdentity, engineIdentity)) {
  throw new Error("The loaded search model or index changed after this session started; start a new session.");
}
session ??= {
  schemaVersion: 2,
  startedAt: new Date().toISOString(),
  updatedAt: null,
  querySet: {
    path: querySetPath,
    sha256: querySetDigest,
    count: querySet.queries.length,
  },
  engineConfig: engineOptions,
  evaluationConfig: evaluationOptions,
  implementation,
  engineIdentity,
  engine: {
    model: engine.model,
    index: engine.index,
    initializationTimingsMs: engine.initializationTimingsMs,
  },
  entries: [],
  summary: null,
};
await saveSession(outputPath, session, querySet);

console.log("\nFor each query, enter relevant result numbers such as 1 or 1,3.");
console.log("Use n when none are relevant, s to skip, or q to save and quit.\n");
console.log(`Session: ${outputPath}\n`);

const completedIds = new Set(session.entries.map((entry) => entry.id));
const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
let quitRequested = false;
try {
  for (let index = 0; index < querySet.queries.length; index += 1) {
    const evaluationQuery = querySet.queries[index];
    if (completedIds.has(evaluationQuery.id)) continue;

    const response = await engine.search(evaluationQuery.query, {
      limit: engineOptions.limit,
      diagnosticLimit: evaluationOptions.diagnosticLimit,
    });
    printQuery(index, querySet.queries.length, evaluationQuery, response);
    const duplicateGroups = duplicateCapabilityGroups(response.results);
    if (duplicateGroups.length > 0) {
      console.log(`Duplicate names in these results: ${duplicateGroups.map((group) => group.map((item) => item.rank).join("/")).join(", ")}`);
    }

    let judgment;
    while (!judgment) {
      const input = await terminal.question("Relevant results [1,3 | n | s | q]: ");
      try {
        judgment = parseJudgment(input, response.results.length);
      } catch (error) {
        console.log(error.message);
      }
    }
    if (judgment.action === "quit") {
      quitRequested = true;
      break;
    }

    session.entries.push({
      id: evaluationQuery.id,
      category: evaluationQuery.category,
      intent: evaluationQuery.intent,
      query: evaluationQuery.query,
      response,
      duplicateGroups,
      judgment: {
        ...judgment,
        judgedAt: new Date().toISOString(),
      },
    });
    completedIds.add(evaluationQuery.id);
    await saveSession(outputPath, session, querySet);
    printSummary(session.summary);
    console.log("");
  }
} finally {
  terminal.close();
}

await saveSession(outputPath, session, querySet);
console.log(quitRequested ? "Evaluation saved for later." : "Evaluation query set completed.");
printSummary(session.summary);
console.log(`Session: ${outputPath}`);

function printQuery(index, total, evaluationQuery, response) {
  console.log(`\n[${index + 1}/${total}] ${evaluationQuery.query}`);
  console.log(`Intent: ${evaluationQuery.intent}\n`);
  if (response.decision.action === "abstain") {
    console.log(`No skill search triggered (${response.decision.reason}).`);
  }
  for (const result of response.results) {
    console.log(`${result.rank}. ${result.name} (${result.type}, ${result.ecosystem})`);
    console.log(`   ${result.description || "No description available."}`);
    console.log(
      `   semantic: ${formatRank(result.semantic)}; lexical: ${formatRank(result.lexical)}; id: ${result.id}`,
    );
  }
  console.log(`\nQuery time: ${response.timingsMs.queryTotal} ms`);
}

function formatRank(value) {
  return value ? `#${value.rank} score ${value.score}` : "-";
}

function printSummary(summary) {
  console.log(
    `Progress ${summary.completed + summary.skipped}/${summary.totalQueries} `
    + `(${summary.completed} judged, ${summary.skipped} skipped, ${summary.remaining} remaining)`,
  );
  console.log(
    `Positive hit rate: ${formatMetric(summary.positive.hitRate)}; `
    + `positive precision: ${formatMetric(summary.positive.precision)}; `
    + `positive search rate: ${formatMetric(summary.positive.searchRate)}; `
    + `abstain no-relevant rate: ${formatMetric(summary.abstain.noRelevantRate)}; `
    + `engine suppression rate: ${formatMetric(summary.abstain.suppressionRate)}; `
    + `queries with duplicate names: ${summary.duplicateQueries}`,
  );
}

function formatMetric(value) {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

async function saveSession(outputPath, session, querySet) {
  session.updatedAt = new Date().toISOString();
  session.summary = summarizeEvaluation(querySet, session.entries);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`);
  await fs.rename(temporaryPath, outputPath);
}

function parseArgs(args) {
  const result = {
    queries: null,
    output: null,
    resume: null,
    mode: "hybrid",
    model: "gte",
    index: null,
    limit: 3,
    threads: 4,
    offline: false,
    diagnosticLimit: 50,
    confidenceThreshold: 0.0725,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--queries") result.queries = path.resolve(args[++index]);
    else if (argument === "--output") result.output = path.resolve(args[++index]);
    else if (argument === "--resume") result.resume = path.resolve(args[++index]);
    else if (argument === "--mode") result.mode = args[++index];
    else if (argument === "--model") result.model = args[++index];
    else if (argument === "--index") result.index = path.resolve(args[++index]);
    else if (argument === "--limit") result.limit = positiveInteger(args[++index], "limit");
    else if (argument === "--threads") result.threads = positiveInteger(args[++index], "threads");
    else if (argument === "--offline") result.offline = true;
    else if (argument === "--confidence-threshold") {
      result.confidenceThreshold = nonNegativeNumber(args[++index], "confidence-threshold");
    }
    else if (argument === "--diagnostic-limit") {
      result.diagnosticLimit = nonNegativeInteger(args[++index], "diagnostic-limit");
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["lexical", "semantic", "hybrid"].includes(result.mode)) {
    throw new Error(`Expected mode lexical, semantic, or hybrid; received: ${result.mode}.`);
  }
  return result;
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

async function implementationIdentity() {
  const transformersPackage = await readJson(
    path.join(here, "node_modules", "@huggingface", "transformers", "package.json"),
  );
  return {
    schemaVersion: 1,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      transformers: transformersPackage.version,
    },
    files: Object.fromEntries(await Promise.all(implementationFiles.map(async (file) => [
      file,
      await sha256File(path.join(here, file)),
    ]))),
  };
}

function sameValue(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
