# Catalogue Data

The catalogue is a generated, browsable data set for agentwheel-installable and adjacent agent ecosystem resources. It combines official registry entries from `index.json`, public OpenPack repositories, installable MCP Registry remotes, public ClawHub plugins, curated Vercel skills.sh entries, and SkillKit-compatible repositories.

## Data Contract

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-11T00:00:00.000Z",   // ISO; preserved from previous file if entries unchanged
  "entries": [
    {
      "id": "official:nestdev-core-toolkit",    // "<ecosystem>:<unique-key>"
      "name": "nestdev-core-toolkit",
      "ecosystem": "official",                  // "official" | "openpack" | "mcp-registry" | "clawhub" | "vercel" | "skillkit"
      "type": "package",                        // "package" | "skill" | "plugin" | "mcp" | "adapter"
      "description": "...",
      "tags": ["agents", "skills"],
      "source": "github:NestDevLab/agent-core-toolkit-public",   // agentwheel source string
      "installCommand": "npx agentwheel install nestdev-core-toolkit",
      "repoUrl": "https://github.com/NestDevLab/agent-core-toolkit-public", // null for non-GitHub sources
      "homepageUrl": null,                      // skills.sh page for vercel entries, else null
      "stars": 12,                              // null when enrichment failed
      "lastPush": "2026-06-01T10:00:00Z",       // null when enrichment failed
      "archived": false,
      "provides": ["instructions", "rules", "skills"],  // official only, from remote manifest; else null
      "version": "0.1.0"                        // official only, from remote manifest; else null
    }
  ]
}
```

Curated Vercel seed entries in `catalogue-data.json` include `"featured": true`; official registry, OpenPack, MCP Registry, ClawHub, and SkillKit entries omit the flag.

The builder also writes `catalogue-vercel-index.json`, a compact index of every skill listed in the skills.sh sitemaps:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-11T00:00:00.000Z",
  "count": 20000,
  "entries": [
    { "o": "owner", "r": "repo", "s": "skill", "d": "Optional meta description from skills.sh." }
  ]
}
```

This second file is refreshed weekly with the main catalogue, contains roughly 20k Vercel skills, and intentionally does not include GitHub enrichment. Descriptions are crawled incrementally from skills.sh meta descriptions into the optional compact `d` field and are carried forward across runs. After missing descriptions are crawled, any remaining `CRAWL_CAP` budget refreshes a deterministic weekly slice of existing descriptions so cached text rolls forward over time. The site expands these compact records at runtime and uses skills.sh as the verification source.

## Adding Entries

All registry entries appear automatically from the root `index.json`. Public OpenPack repositories are discovered with GitHub code search when `GITHUB_TOKEN` is available. MCP Registry entries are collected from the public registry and included only when they expose an unauthenticated `streamable-http` remote that Agentwheel can install. ClawHub plugin entries are collected from ClawHub's public plugin API, linked back to the canonical ClawHub listing, and installed through Agentwheel's `clawhub:` source driver with `--only-source --execute-plugins`. SkillKit entries are collected from SkillKit's marketplace `sources.json`, with `catalogue/seeds/skillkit.json` used as an override layer for curated descriptions and any extra seed-only repositories. Curated Vercel entries are added by pull request to:

- `catalogue/seeds/vercel.json`
- `catalogue/seeds/skillkit.json`

Keep descriptions concise and tags useful for search.

## Refreshing Data

The `Update catalogue data` GitHub Actions workflow refreshes `catalogue-data.json` and `catalogue-vercel-index.json` weekly, on manual dispatch, and after changes to `index.json` or `catalogue/**` on `main`.

Run the builder locally with:

```bash
GITHUB_TOKEN="$(gh auth token)" node catalogue/build.mjs
```

Use `CRAWL_CAP` to bound skills.sh description page crawls; the default is 5000 and `CRAWL_CAP=0` refreshes catalogue metadata without page crawls. Use `node catalogue/build.mjs --check` to verify that committed catalogue data is current without crawling description pages; check mode ignores volatile GitHub star counts and last-push timestamps.

Use `OPENPACK_CRAWL_CAP`, `MCP_REGISTRY_CRAWL_CAP`, and `CLAWHUB_CRAWL_CAP` to bound OpenPack, MCP Registry, and ClawHub discovery. Set any cap to `0` to carry forward already committed entries for that ecosystem without refreshing it.
