import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCatalogue,
  sha256File,
  validateIndexMetadata,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryRoot = path.resolve(here, "../..");
const outputDir = path.join(registryRoot, "catalogue-semantic-index", "gte-v1");
const [catalogue, models, metadata] = await Promise.all([
  loadCatalogue(
    path.join(registryRoot, "catalogue-data.json"),
    path.join(registryRoot, "catalogue-vercel-index.json"),
  ),
  readJson(path.join(here, "models.json")),
  readJson(path.join(outputDir, "metadata.json")),
]);

validateIndexMetadata(metadata, catalogue, models.gte);
for (const name of ["ids", "vectors", "norms"]) {
  const descriptor = metadata.files?.[name];
  if (!descriptor || typeof descriptor.path !== "string") throw new Error(`Missing web index ${name} descriptor.`);
  const filePath = path.join(outputDir, descriptor.path);
  const stat = await fs.stat(filePath);
  if (stat.size !== descriptor.bytes) throw new Error(`Web index ${name} size mismatch.`);
  if (await sha256File(filePath) !== descriptor.sha256) throw new Error(`Web index ${name} checksum mismatch.`);
}
console.log(`Web semantic index is current (${metadata.count} records).`);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
