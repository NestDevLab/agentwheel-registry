# Agentwheel Registry For AI Agents

This repository is the public Agentwheel registry and catalogue data source. Use it when a user wants
to add, review, or publish resources that should appear in the Agentwheel catalogue.

## What Belongs Here

- Root `index.json`: curated registry entries resolved by short name.
- `catalogue/`: builder and docs for generated catalogue data.
- `catalogue-data.json`: generated catalogue entries used by the static site.
- `catalogue-vercel-index.json`: generated compact Vercel skills index.

Do not hand-edit generated catalogue files unless the task is explicitly a catalogue refresh result.
For curated additions, edit `index.json` or the relevant seed file, then run the builder check.

## Publishing Flow

Use [`catalogue/publish.md`](catalogue/publish.md) as the agent-facing workflow. In short:

```bash
node catalogue/build.mjs --check
```

When avoiding network crawls during validation:

```bash
CRAWL_CAP=0 OPENPACK_CRAWL_CAP=0 MCP_REGISTRY_CRAWL_CAP=0 CLAWHUB_CRAWL_CAP=0 node catalogue/build.mjs --check
```

## Source Types

Valid public source families include:

- `github:` and `git:` OpenPack packages
- `skillkit:`
- `vercel:`
- `mcp-registry:`
- `clawhub:`

ClawHub catalogue entries should install through Agentwheel's `clawhub:` source driver, not by
showing native `openclaw plugins install` as the catalogue command.

## Safety

- Keep entries public and resolvable without private credentials.
- Keep names stable and descriptions short.
- Do not add private customer, tenant, or local-only paths.
- Treat Git commits, pushes, and pull requests as separate delivery actions.
