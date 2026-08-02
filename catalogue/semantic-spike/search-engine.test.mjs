import assert from "node:assert/strict";
import test from "node:test";
import { createSearchEngine } from "./search-engine.mjs";

test("the lexical engine deterministically routes a multi-token exact capability name", async () => {
  const engine = await createSearchEngine({ mode: "lexical", limit: 3 });
  const response = await engine.search("review-ticket");

  assert.equal(response.decision.action, "search");
  assert.equal(response.retrievalPolicy.fusion.profile, "short-lookup");
  assert.equal(response.results[0].name, "review-ticket");
  assert.equal("total" in response.timingsMs, false);
  assert.equal("modelLoad" in response.timingsMs, false);
  assert.ok(response.timingsMs.queryTotal >= 0);
  assert.ok(engine.initializationTimingsMs.total >= engine.initializationTimingsMs.catalogueLoad);
});
