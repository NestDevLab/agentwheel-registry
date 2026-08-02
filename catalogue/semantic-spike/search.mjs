import { createAbstentionResponse, createSearchEngine } from "./search-engine.mjs";
import { classifyDiscoveryIntent } from "./retrieval-policy.mjs";

const options = parseArgs(process.argv.slice(2));
const decision = classifyDiscoveryIntent(options.query);
let response;
if (decision.action === "abstain") {
  response = createAbstentionResponse(options.query, {
    mode: options.mode,
    offline: options.offline,
    decision,
  });
} else {
  const engine = await createSearchEngine({
    mode: options.mode,
    model: options.model,
    index: options.index,
    limit: options.limit,
    threads: options.threads,
    offline: options.offline,
    confidenceThreshold: options.confidenceThreshold,
    onProgress: (message) => progress(options, message),
  });
  response = await engine.search(options.query, { limit: options.limit });
}
response.timingsMs.cliColdTotal = round(performance.now());

if (options.json) {
  console.log(JSON.stringify(response, null, 2));
} else {
  printHumanResponse(response);
}

function printHumanResponse(response) {
  if (response.decision.action === "abstain") {
    console.log(`\nSkill search not triggered (${response.decision.reason}).`);
    return;
  }
  console.log(`\n${response.mode.toUpperCase()} results for: ${response.query}\n`);
  console.table(response.results.map((result) => ({
    rank: result.rank,
    name: result.name,
    type: result.type,
    ecosystem: result.ecosystem,
    semantic: result.semantic?.rank ?? "-",
    lexical: result.lexical?.rank ?? "-",
  })));
  for (const result of response.results) {
    console.log(`${result.rank}. ${result.name}`);
    console.log(`   ${result.description || "No description available."}`);
    console.log(`   id: ${result.id}`);
    console.log(`   semantic rank: ${result.semantic?.rank ?? "-"}; lexical rank: ${result.lexical?.rank ?? "-"}`);
  }
  if (response.initializationTimingsMs) {
    console.log("\nInitialization timings (ms):", response.initializationTimingsMs);
  }
  console.log("\nQuery and CLI timings (ms):", response.timingsMs);
}

function parseArgs(args) {
  const result = {
    query: "",
    mode: "hybrid",
    model: "gte",
    index: null,
    limit: 3,
    threads: 4,
    offline: false,
    json: false,
    confidenceThreshold: 0.0725,
  };
  const queryParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--mode") result.mode = args[++index];
    else if (argument === "--model") result.model = args[++index];
    else if (argument === "--index") result.index = args[++index];
    else if (argument === "--limit") result.limit = positiveInteger(args[++index], "limit");
    else if (argument === "--threads") result.threads = positiveInteger(args[++index], "threads");
    else if (argument === "--confidence-threshold") {
      result.confidenceThreshold = nonNegativeNumber(args[++index], "confidence-threshold");
    }
    else if (argument === "--offline") result.offline = true;
    else if (argument === "--json") result.json = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    else queryParts.push(argument);
  }
  result.query = queryParts.join(" ").trim();
  if (!result.query) throw new Error("Provide an English search query.");
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

function nonNegativeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected ${label} to be a non-negative number, received: ${value}.`);
  }
  return parsed;
}

function progress(options, message) {
  if (options.json) console.error(message);
  else console.log(message);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
