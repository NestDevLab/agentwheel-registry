# Catalogue Data

The catalogue is a generated, browsable data set for agentwheel-installable resources. It combines official registry entries from `index.json` with curated Vercel skills.sh and SkillKit-compatible repositories.

## Data Contract

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-11T00:00:00.000Z",   // ISO; preserved from previous file if entries unchanged
  "entries": [
    {
      "id": "official:nestdev-core-toolkit",    // "<ecosystem>:<unique-key>"
      "name": "nestdev-core-toolkit",
      "ecosystem": "official",                  // "official" | "vercel" | "skillkit"
      "type": "package",                        // "package" | "skill"
      "description": "...",
      "tags": ["agents", "skills"],
      "source": "github:NestDevLab/agent-core-toolkit-public",   // agentwheel source string
      "installCommand": "agentwheel install nestdev-core-toolkit",
      "repoUrl": "https://github.com/NestDevLab/agent-core-toolkit-public",
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

## Adding Entries

Official packages appear automatically from the root `index.json`. Curated third-party entries are added by pull request to:

- `catalogue/seeds/vercel.json`
- `catalogue/seeds/skillkit.json`

Keep descriptions concise and tags useful for search.

## Refreshing Data

The `Update catalogue data` GitHub Actions workflow refreshes `catalogue-data.json` weekly, on manual dispatch, and after changes to `index.json` or `catalogue/**` on `main`.

Run the builder locally with:

```bash
GITHUB_TOKEN="$(gh auth token)" node catalogue/build.mjs
```

Use `node catalogue/build.mjs --check` to verify that committed catalogue data is current.
