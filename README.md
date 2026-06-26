# agentwheel Registry

Community registry for discoverable agentwheel packages.

The registry is optional. It gives `agentwheel add <short-name>` a public index to resolve from, but it is not a gatekeeper: direct sources such as git URLs, local paths, `skillkit:...`, `vercel:...`, `mcp-registry:...`, and `clawhub:...` continue to work without this repository.

## Format

The registry is a JSON index at `index.json`.

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "name": "example-pack",
      "source": "git:https://github.com/example/agent-pack.git#main",
      "type": "package",
      "description": "Example skills, rules, and instructions for agentwheel.",
      "tags": ["example", "agents"]
    }
  ]
}
```

Each entry has these fields:

- `name`: short name used by `agentwheel add <name>`.
- `source`: resolvable source string, such as `git:...`, `skillkit:...`, or `vercel:...`.
- `type`: one of `package`, `skill`, `plugin`, `mcp`, or `adapter`.
- `description`: short human-readable summary.
- `tags`: optional search tags.

## Catalogue

Registry entries automatically appear in the generated resource catalogue.
The catalogue data pipeline also discovers public OpenPack repositories and installable MCP Registry remotes. It is documented in [`catalogue/README.md`](catalogue/README.md).
Browse the published site page at <https://nestdevlab.github.io/agentwheel/catalogue.html>.

For AI-agent assisted publishing, use [`AGENT.md`](AGENT.md), [`llms.txt`](llms.txt), and
[`catalogue/publish.md`](catalogue/publish.md).

## Contributing

Open a pull request that updates `index.json`.

Entries should point to public, resolvable sources and should not require private credentials. Keep names stable, descriptions concise, and tags generic enough to help discovery.
