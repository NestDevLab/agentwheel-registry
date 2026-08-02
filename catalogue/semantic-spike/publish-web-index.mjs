import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryRoot = path.resolve(here, "../..");
const options = parseArgs(process.argv.slice(2));
const inputDir = options.input ? path.resolve(options.input) : await findLatestCompleteIndex();
const outputDir = path.resolve(options.output);
const sourceMetadata = JSON.parse(await fs.readFile(path.join(inputDir, "metadata.json"), "utf8"));

if (sourceMetadata.count < 1 || sourceMetadata.dimensions < 1) {
  throw new Error("The benchmark index metadata is incomplete.");
}

await fs.mkdir(outputDir, { recursive: true });
const fileNames = {
  ids: sourceMetadata.files.ids,
  vectors: sourceMetadata.files.vectors,
  norms: sourceMetadata.files.norms,
};
const files = {};
for (const [name, filename] of Object.entries(fileNames)) {
  const source = path.join(inputDir, filename);
  const target = path.join(outputDir, filename);
  await fs.copyFile(source, target);
  const stat = await fs.stat(target);
  files[name] = {
    path: filename,
    bytes: stat.size,
    sha256: await sha256File(target),
  };
}

const metadata = {
  schemaVersion: sourceMetadata.schemaVersion,
  textSchemaVersion: sourceMetadata.textSchemaVersion,
  createdAt: sourceMetadata.createdAt,
  model: {
    id: sourceMetadata.model.id,
    revision: sourceMetadata.model.revision,
    dimensions: sourceMetadata.model.dimensions,
    dtype: sourceMetadata.model.dtype,
    q8ModelBytes: sourceMetadata.model.q8ModelBytes,
    pooling: sourceMetadata.model.pooling,
    normalize: sourceMetadata.model.normalize ?? true,
    queryPrefix: sourceMetadata.model.queryPrefix ?? "",
    documentPrefix: sourceMetadata.model.documentPrefix ?? "",
  },
  runtime: {
    library: "@huggingface/transformers@4.2.0",
  },
  catalogue: sourceMetadata.catalogue,
  count: sourceMetadata.count,
  dimensions: sourceMetadata.dimensions,
  vectorFormat: sourceMetadata.vectorFormat,
  normFormat: sourceMetadata.normFormat,
  files,
};
await fs.writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Published web index: ${outputDir}`);
console.log(`Records: ${metadata.count}; files: ${Object.values(files).reduce((sum, file) => sum + file.bytes, 0)} bytes`);

function parseArgs(args) {
  const result = {
    input: null,
    output: path.join(registryRoot, "catalogue-semantic-index", "gte-v1"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input") result.input = args[++index];
    else if (argument === "--output") result.output = args[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

async function findLatestCompleteIndex() {
  const root = path.join(here, "var", "gte");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .sort((first, second) => Number(second.name) - Number(first.name));
  for (const candidate of candidates) {
    const directory = path.join(root, candidate.name);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8"));
      if (metadata.count === Number(candidate.name)) return directory;
    } catch {
      // Ignore incomplete benchmark directories.
    }
  }
  throw new Error("No complete GTE index was found. Run the full benchmark first.");
}
