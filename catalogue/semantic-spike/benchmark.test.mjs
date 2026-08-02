import assert from "node:assert/strict";
import test from "node:test";
import {
  computeInt8Centroid,
  dotProduct,
  expectedRank,
  fuseSearchResults,
  lexicalSearch,
  quantizeVectors,
  retrievalMetrics,
  searchFloat,
  searchInt8,
  selectCorpus,
  validateIndexMetadata,
} from "./lib.mjs";

test("selectCorpus always keeps required records and is deterministic", () => {
  const records = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const first = selectCorpus(records, 3, ["e"]);
  const second = selectCorpus([...records].reverse(), 3, ["e"]);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.ok(first.some(({ id }) => id === "e"));
});

test("int8 search preserves the float nearest neighbour", () => {
  const vectors = Float32Array.from([
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  const query = Float32Array.from([0.9, 0.1, 0]);
  const quantized = quantizeVectors(vectors, 3);
  assert.equal(searchFloat(vectors, 3, query, 1)[0].row, 0);
  assert.equal(searchInt8(quantized, 3, query, 1)[0].row, 0);
});

test("the int8 centroid exposes mean corpus similarity", () => {
  const quantized = quantizeVectors(Float32Array.from([
    1, 0,
    0, 1,
  ]), 2);
  const centroid = computeInt8Centroid(quantized, 2);
  assert.ok(Math.abs(centroid[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(centroid[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(dotProduct(Float32Array.from([1, 0]), centroid) - 0.5) < 1e-6);
});

test("lexical search and metrics expose expected ranks", () => {
  const records = [
    { id: "a", name: "email-triage", description: "Organize an inbox", tags: [], provides: [], type: "skill", ecosystem: "vercel" },
    { id: "b", name: "calendar", description: "Schedule meetings", tags: [], provides: [], type: "skill", ecosystem: "vercel" },
  ];
  const results = lexicalSearch(records, "organize inbox", 2);
  assert.equal(expectedRank(results, records, ["a"]), 1);
  assert.deepEqual(retrievalMetrics([1, 2, null]), {
    queries: 3,
    hitAt1: 0.3333,
    hitAt5: 0.6667,
    hitAt10: 0.6667,
    mrrAt10: 0.5,
  });
});

test("hybrid rank fusion rewards results found by both search modes", () => {
  const semantic = [
    { row: 0, score: 0.95 },
    { row: 1, score: 0.9 },
  ];
  const lexical = [
    { row: 1, score: 500 },
    { row: 2, score: 400 },
  ];
  assert.deepEqual(fuseSearchResults(semantic, lexical, 3, 60), [
    {
      row: 1,
      score: (1 / 62) + (1 / 61),
      semanticRank: 2,
      semanticScore: 0.9,
      lexicalRank: 1,
      lexicalScore: 500,
    },
    {
      row: 0,
      score: 1 / 61,
      semanticRank: 1,
      semanticScore: 0.95,
      lexicalRank: null,
      lexicalScore: null,
    },
    {
      row: 2,
      score: 1 / 62,
      semanticRank: null,
      semanticScore: null,
      lexicalRank: 2,
      lexicalScore: 400,
    },
  ]);
});

test("weighted fusion prevents lexical-only noise from entering natural-language results", () => {
  const semantic = [
    { row: 0, score: 0.9 },
    { row: 1, score: 0.85 },
  ];
  const lexical = [
    { row: 2, score: 10000 },
    { row: 1, score: 80 },
  ];
  const results = fuseSearchResults(semantic, lexical, 3, {
    semanticWeight: 1,
    lexicalWeight: 0.35,
    allowLexicalOnly: false,
  });
  assert.deepEqual(results.map(({ row }) => row), [1, 0]);
  assert.equal(results.some(({ row }) => row === 2), false);
});

test("natural-language fusion does not boost distant semantic candidates", () => {
  const semantic = Array.from({ length: 12 }, (_, row) => ({ row, score: 1 - (row / 100) }));
  const lexical = [{ row: 11, score: 10000 }];
  const results = fuseSearchResults(semantic, lexical, 12, {
    semanticWeight: 1,
    lexicalWeight: 0.35,
    allowLexicalOnly: false,
    maxLexicalBoostSemanticRank: 10,
  });
  assert.equal(results[11].row, 11);
});

test("index metadata must match the exact catalogue and model revision", () => {
  const model = {
    id: "example/model",
    revision: "abc",
    dimensions: 3,
    dtype: "q8",
    pooling: "mean",
    normalize: true,
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
  };
  const catalogue = {
    records: [{ id: "one" }, { id: "two" }],
    sources: {
      enriched: { sha256: "catalogue-sha" },
      vercel: { sha256: "vercel-sha" },
    },
  };
  const metadata = {
    schemaVersion: 1,
    textSchemaVersion: 1,
    count: 2,
    dimensions: 3,
    vectorFormat: "signed-int8-per-vector-scaled",
    normFormat: "float32-little-endian",
    model,
    catalogue: catalogue.sources,
  };
  assert.doesNotThrow(() => validateIndexMetadata(metadata, catalogue, model));
  assert.throws(
    () => validateIndexMetadata({ ...metadata, count: 1 }, catalogue, model),
    /Index contains 1 records/,
  );
  assert.throws(
    () => validateIndexMetadata({ ...metadata, model: { ...model, revision: "other" } }, catalogue, model),
    /model revision mismatch/,
  );
  assert.throws(
    () => validateIndexMetadata({
      ...metadata,
      catalogue: { ...metadata.catalogue, enriched: { sha256: "other" } },
    }, catalogue, model),
    /checksum mismatch for enriched/,
  );
  assert.throws(
    () => validateIndexMetadata({
      ...metadata,
      model: { ...model, documentPrefix: "" },
    }, catalogue, model),
    /prefix contract mismatch/,
  );
  assert.throws(
    () => validateIndexMetadata({ ...metadata, vectorFormat: "float32" }, catalogue, model),
    /vector format/,
  );
  assert.throws(
    () => validateIndexMetadata({ ...metadata, normFormat: "float64" }, catalogue, model),
    /norm format/,
  );
  assert.throws(
    () => validateIndexMetadata({
      ...metadata,
      model: { ...model, dtype: "fp32" },
    }, catalogue, model),
    /dtype mismatch/,
  );
  assert.throws(
    () => validateIndexMetadata({
      ...metadata,
      model: { ...model, pooling: "cls" },
    }, catalogue, model),
    /pooling mismatch/,
  );
  assert.throws(
    () => validateIndexMetadata({
      ...metadata,
      model: { ...model, normalize: false },
    }, catalogue, model),
    /normalization mismatch/,
  );
});
