# Publish To The Agentwheel Catalogue

Use this file when a user gives an AI agent a markdown prompt and asks it to publish, submit, or fix
an Agentwheel catalogue entry.

## Goal

Add or update a public, installable resource without breaking generated catalogue data.

## Decide The Source

Prefer the most direct Agentwheel source string:

- OpenPack package: `github:owner/repo` or `git:https://host/owner/repo.git#ref`
- SkillKit: `skillkit:owner/skill-name`
- Vercel skills: `vercel:owner/skill-name`
- MCP Registry: `mcp-registry:publisher/server-name`
- ClawHub: `clawhub:@scope/package`

Use root `index.json` for curated official or manual short-name entries. Use catalogue seed files
only for ecosystem-specific curated overrides that the builder already supports.

## Entry Rules

- Public source only; no private credentials.
- Stable short name.
- `type` must be one of `package`, `skill`, `plugin`, `mcp`, or `adapter`.
- Description should be concise and factual.
- Tags should help search, not duplicate every word in the name.
- Do not duplicate entries already discovered from OpenPack, MCP Registry, ClawHub, Vercel, or
  SkillKit unless a curated registry short name is intentional.

## Validate

Run the low-crawl check first:

```bash
CRAWL_CAP=0 OPENPACK_CRAWL_CAP=0 MCP_REGISTRY_CRAWL_CAP=0 CLAWHUB_CRAWL_CAP=0 node catalogue/build.mjs --check
```

If the task explicitly requires refreshing generated data, run the builder with the requested crawl
scope and review generated changes carefully:

```bash
node catalogue/build.mjs
```

## Install Command Checks

OpenPack package:

```bash
agentwheel install github:owner/repo --adapter codex --local --dry-run
```

MCP Registry:

```bash
agentwheel install mcp-registry:publisher/server-name --adapter claude --local --mcp server-name --dry-run
```

ClawHub:

```bash
agentwheel install clawhub:@scope/package --adapter openclaw --local --dry-run
```

Plugin execution is opt-in. Do not add `--execute-plugins` unless the user explicitly asks to run
plugin installs, and do not make native `openclaw plugins install ...` the catalogue command.

## Handoff

Report:

- entry or seed files changed
- generated files changed or intentionally unchanged
- builder check result
- install command checked
- any source that could not be verified
