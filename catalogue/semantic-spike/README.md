# English Semantic Catalogue Search Spike

This local spike tests whether Agentwheel can publish a static semantic index that a browser can
search without a hosted LLM or paid query API. It is intentionally English-only and does not change
the production catalogue builder or website.

## What it measures

- retrieval quality against a small, human-selected English relevance set;
- q8 model download size and model revision;
- corpus and query embedding latency using the Transformers.js Node CPU runtime for model screening;
- exact cosine-search latency for float32 and per-vector int8 indexes;
- int8 index size and ranking loss relative to float32;
- a deterministic weighted lexical baseline.

The relevance set is deliberately small. Its results are evidence for model selection, not a claim
that semantic search quality is production-ready. Node does not expose the browser WASM execution
provider, so browser latency remains a separate promotion gate and must not be inferred from these
CPU timings.

## Models

| Alias | Model | License | Dimensions | q8 model |
| --- | --- | --- | ---: | ---: |
| `minilm` | `Xenova/all-MiniLM-L6-v2` | Apache-2.0 | 384 | 22.97 MB |
| `bge` | `Xenova/bge-small-en-v1.5` | MIT | 384 | 34.01 MB |
| `gte` | `Xenova/gte-small` | MIT | 384 | 34.01 MB |
| `e5` | `Xenova/e5-small-v2` | MIT | 384 | 34.01 MB |

The conversion and base-model revisions are pinned in `models.json`. Model metadata and licenses
were checked against the Hugging Face model repositories before the spike.

## Recorded results

All four models were screened on the same deterministic 4,000-record corpus with 13 English
paraphrase queries, q8 weights, 384-dimensional vectors, and four CPU threads.

| Model | hit@1 | hit@5 | hit@10 | MRR@10 | Embed corpus | Query p50 | int8 search p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniLM | 15.4% | 46.2% | 46.2% | 0.269 | 108.1 s | 3.04 ms | 1.74 ms |
| BGE-small | 23.1% | 46.2% | 61.5% | 0.344 | 212.7 s | 5.90 ms | 1.87 ms |
| GTE-small | **30.8%** | **53.9%** | **69.2%** | **0.428** | 210.1 s | 4.58 ms | 1.73 ms |
| E5-small-v2 | 23.1% | 46.2% | 46.2% | 0.301 | 140.8 s | 4.98 ms | 2.40 ms |
| Weighted lexical baseline | 15.4% | 23.1% | 23.1% | 0.192 | n/a | n/a | n/a |

GTE-small is the provisional winner: it produced the best retrieval scores, tied BGE-small on q8
weight size, and was faster for query embedding in this Node CPU screen. MiniLM remains a useful
payload fallback because its q8 weights are about 11 MB smaller.

E5-small-v2 was screened as an English-only asymmetric retrieval candidate. Its mandatory `query: `
and `passage: ` prefixes are applied by the benchmark/index contract, but it did not beat GTE and
therefore was not promoted to a full-catalogue build.

The complete 25,225-record GTE run used eight CPU threads and produced:

- a 9,686,400-byte int8 vector file, a 1,262,829-byte ID map, and a 100,900-byte
  norm file (11,050,129 bytes combined; about 7.96 MB with gzip for those three files);
- q8 model weights of 34,014,426 bytes, before tokenizer and runtime files;
- 4.53 ms median query embedding and 12.40 ms median exact int8 search in the Node CPU runtime;
- 100% average top-10 overlap between int8 and float32 search for this query set;
- 16.1 minutes to embed the full catalogue, paid only when rebuilding the index.

On the complete corpus, the small relevance set understates real quality: several unlabelled first
results are directly relevant (for example `accessibility-testing`, `PDF Extract Text`, and
`just-publish`). The complete-corpus measured hit@10 was 46.2% for GTE versus 23.1% for the lexical
baseline, but these values must not be used as a production acceptance threshold until an
independent reviewer expands the relevance judgements without selecting answers from model output.

## Run

```bash
npm install
npm test
npm run benchmark -- --model minilm --limit 4000
npm run benchmark -- --model bge --limit 4000
npm run benchmark -- --model gte --limit 4000
npm run benchmark -- --model gte --limit 0 --threads 8
```

`--limit 0` uses the complete catalogue. Each run always includes every expected relevance target,
then fills a limited corpus with a deterministic sample. Generated models, vectors, and reports are
written below `var/` and ignored by Git.

## Try local search

After building the complete GTE index once, run arbitrary English queries against the local files:

```bash
npm run search -- "find defects in a proposed code change" --mode hybrid --offline
npm run search -- "organize my mailbox and identify urgent messages" --mode semantic --offline
npm run search -- "code review" --mode lexical
```

Modes are `lexical`, `semantic`, and `hybrid`. Hybrid mode uses reciprocal-rank fusion instead of
mixing incomparable lexical and cosine scores. Natural-language queries use semantic retrieval
only; the local lexical scan is skipped, avoiding both noisy keyword promotion and its roughly
half-second cost. Short lookup-like queries and queries that exactly match any normalized catalogue
name still use weighted lexical matches. The engine
retrieves at least 100 candidates and groups records with the same
normalized capability name into one result with source-preserving `alternates`. Alternates are
labelled as `mirror` or `variant` from description equality and document-vector similarity, so
same-name implementations remain inspectable instead of disappearing. Freed slots are backfilled.
It returns three results by default; use `--limit`, `--json`, and
`--threads` to change the output or runtime. `--offline` makes model loading fail instead of
contacting the network when the pinned model is absent from the local cache.

JSON output separates one-time `initializationTimingsMs` (catalogue, index, centroid, and model)
from per-query `timingsMs`. The standalone CLI adds `cliColdTotal`, measured from Node process start,
so warm engine reuse is never reported as if it paid model initialization again.

A conservative English conversation gate returns no skill results for narrow acknowledgements,
greetings, conversation controls, recall prompts, and simple arithmetic. The standalone search
command applies this gate before loading the embedding model, so a browser can reuse the same
policy to avoid downloading model assets until a genuine discovery request arrives. This gate is
not a general intent classifier and needs held-out conversational evaluation before promotion.

This command is a local ranking harness, not the public `agentwheel search` implementation. It
applies the experimental deterministic and centered-confidence abstention policies described here,
but does not yet apply installed-capability, trust, or runtime-compatibility filters.

### Local observations

On the complete 25,225-record index, repeated offline processes loaded the cached GTE model in
roughly 0.38–0.46 seconds. Query embedding took 9–13 ms and exact semantic search took 18–20 ms on
the test host. The unoptimized lexical baseline took 0.49–0.64 seconds and currently dominates
hybrid latency.

Code-review, inbox-management, and persistent-agent-memory queries returned plausible candidates.
Early raw-search runs also exposed irrelevant out-of-domain matches and repeated same-name skills;
the current experimental policy responds with centered-confidence abstention and one capability
result whose source-preserving alternates remain inspectable.

The independently reviewed 90-query frozen holdout at threshold 0.075 measured 93.3% hit rate for
direct requests, 66.7% for paraphrases, 80.0% overall positive hit rate, 56.1% precision, 63.3%
abstention suppression, and no duplicate result names. Lowering the threshold to 0.0725 removes
the three recorded positive false suppressions, but that change used the holdout as calibration.
These numbers therefore do **not** promote the spike: paraphrase precision remains the main quality
gap, and the next promotion attempt requires a new frozen holdout.

## Run the human evaluation

Start the balanced 30-query review with the complete cached model and index:

```bash
npm run evaluate -- --offline
```

The engine is loaded once. Each screen shows three hybrid results plus their semantic and lexical
ranks. Enter:

- `1` or `1,3` to mark one or more results relevant;
- `n` when none of the three results is relevant;
- `s` to skip a query;
- `q` to save and stop.

The query set contains ten direct capability requests, ten semantic paraphrases, and ten ordinary
conversation messages that should not trigger capability discovery. Categories are interleaved;
the evaluator records positive hit rate, positive precision, the no-relevant rate for abstention
queries, and result sets containing duplicate normalized names.

The session path is printed when evaluation starts. New sessions also retain the top 50 raw ranked
candidates (IDs, names, ranks, and scores) for offline calibration; change that diagnostic depth
with `--diagnostic-limit`. Resume a session without changing its model, mode, index, query set,
confidence threshold, or diagnostic depth:

```bash
npm run evaluate -- --resume var/evaluation/evaluation-<timestamp>.json
```

The summary distinguishes manual no-relevant judgments from actual engine suppression, and reports
the positive-query search rate so an overly broad gate cannot look successful. Every judgment is
written atomically before the next query. Session files stay below ignored
`var/`; they contain local human-review evidence and are not committed automatically.

Semantic queries record corpus-background similarity, top centered score, and the top semantic
gap. Centering subtracts the query's mean similarity to the indexed corpus. A conservative 0.0725
threshold avoids the three positive false suppressions observed at 0.075 while retaining most of
its abstention benefit across the first two frozen sets. Both sets are now calibration evidence,
not promotion evidence; a future promotion attempt needs a new frozen holdout.

Evaluation sessions use schema version 2 and pin the query-set digest, engine configuration,
implementation file digests, model identity, catalogue checksums, index creation time, and actual
index-file hashes. Resume aborts if any of those inputs changed, preventing mixed-policy summaries.

## Promotion gate

Before integrating anything into the catalogue pipeline or website:

1. Select a model only after comparing retrieval quality, payload size, and browser-like latency.
2. Run the selected model against the complete catalogue.
3. Expand and independently review the relevance set.
4. Run the selected model in a real browser using WASM and the static int8 index.
5. Define a versioned public index contract linked to exact catalogue checksums and model revision.
6. Keep lexical retrieval as an exact-match and non-English fallback.
