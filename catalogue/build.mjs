import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const check = process.argv.includes("--check");
const ecosystemOrder = new Map([
  ["official", 0],
  ["openpack", 1],
  ["mcp-registry", 2],
  ["clawhub", 3],
  ["skillkit", 4],
  ["vercel", 5],
]);
const entryTypeSet = new Set(["package", "skill", "plugin", "mcp", "adapter"]);
const ecosystemSet = new Set(ecosystemOrder.keys());
const crawlCap = Number.parseInt(process.env.CRAWL_CAP ?? "5000", 10);
const openpackCrawlCap = Number.parseInt(process.env.OPENPACK_CRAWL_CAP ?? "100", 10);
const mcpRegistryCrawlCap = Number.parseInt(process.env.MCP_REGISTRY_CRAWL_CAP ?? "500", 10);
const clawhubCrawlCap = Number.parseInt(process.env.CLAWHUB_CRAWL_CAP ?? "100", 10);
const refreshVercelIndex = process.env.VERCEL_INDEX_REFRESH !== "0";
const skillkitSourcesUrl = "https://raw.githubusercontent.com/rohitg00/skillkit/main/marketplace/sources.json";
const githubCodeSearchUrl = "https://api.github.com/search/code";
const mcpRegistryBaseUrl = "https://registry.modelcontextprotocol.io/v0.1";
const clawhubBaseUrl = "https://clawhub.ai/api/v1";
const crawlConcurrency = 8;
const crawlGapMs = 40;
const skillPageReadLimit = 64 * 1024;

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedCrawlCap() {
  return Number.isFinite(crawlCap) && crawlCap >= 0 ? crawlCap : 5000;
}

function normalizedCap(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function fetchJson(url) {
  await sleep(100);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agentwheel-catalogue",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchRegistryJson(url) {
  await sleep(100);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "agentwheel-catalogue (github.com/NestDevLab/agentwheel-registry)",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchClawHubJson(url) {
  await sleep(100);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "agentwheel-catalogue (github.com/NestDevLab/agentwheel-registry)",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchSkillDescription(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let reader = null;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "agentwheel-catalogue (github.com/NestDevLab/agentwheel-registry)",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("Response body is not streamable");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytesRead = 0;

    while (bytesRead < skillPageReadLimit) {
      const { done, value } = await reader.read();
      if (done) {
        html += decoder.decode();
        return extractPageDescription(html);
      }

      bytesRead += value.byteLength;
      html += decoder.decode(value, { stream: true });
      const description = extractPageDescription(html);
      if (description || bytesRead >= skillPageReadLimit) {
        try {
          await reader.cancel();
        } catch {
          // The request is being aborted deliberately; cancellation may race with the stream.
        }
        controller.abort();
        return description;
      }
    }

    try {
      await reader.cancel();
    } catch {
      // The request is being aborted deliberately; cancellation may race with the stream.
    }
    controller.abort();
    return extractPageDescription(html);
  } finally {
    clearTimeout(timeout);
  }
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]);
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function extractMetaDescription(html) {
  const match = /<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']([^"']*)["'])[^>]*>/i.exec(html);
  const description = match ? decodeHtml(match[1]).trim() : "";
  return description || null;
}

function findJsonDescription(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.description === "string" && value.description.trim()) {
    return value.description.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const description = findJsonDescription(item);
      if (description) return description;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const description = findJsonDescription(item);
    if (description) return description;
  }
  return null;
}

function extractJsonLdDescription(html) {
  const scripts = html.matchAll(/<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    try {
      const description = findJsonDescription(JSON.parse(decodeHtml(script[1])));
      if (description) return description;
    } catch {
      // The streamed chunk may contain an incomplete JSON-LD script; keep reading.
    }
  }
  return null;
}

function extractPageDescription(html) {
  return extractMetaDescription(html) || extractJsonLdDescription(html);
}

function repoFromSource(source) {
  if (typeof source !== "string") return null;

  const patterns = [
    /^github:([^/\s#]+)\/([^/\s#]+)(?:#.*)?$/,
    /^git:https:\/\/github\.com\/([^/\s#]+)\/([^/\s#]+)(?:#.*)?$/,
    /^https:\/\/github\.com\/([^/\s#]+)\/([^/\s#]+)(?:#.*)?$/,
    /^skillkit:github:([^/\s#]+)\/([^/\s#]+)(?:#.*)?$/,
    /^vercel:skills\.sh\/([^/\s#]+)\/([^/\s#]+)(?:\/[^/\s#]+)?(?:#.*)?$/,
    /^vercel:github:([^/\s#]+)\/([^/\s#]+)(?:#.*)?$/,
    /^vercel:([^/\s#]+)\/([^/\s#]+)(?:#.*)?$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
    }
  }

  return null;
}

function repoUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}`;
}

function githubSource(owner, repo) {
  return `github:${owner}/${repo}`;
}

function sourceKey(source) {
  return String(source || "").replace(/#.*$/, "").replace(/^git:https:\/\/github\.com\//, "github:").replace(/\.git$/, "").toLowerCase();
}

async function enrichGitHub(entry, owner, repo) {
  try {
    const repoData = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`);
    entry.stars = repoData.stargazers_count ?? null;
    entry.lastPush = repoData.pushed_at ?? null;
    entry.archived = Boolean(repoData.archived);
    if (!entry.description && repoData.description) {
      entry.description = repoData.description;
    }
  } catch (error) {
    console.warn(`GitHub enrichment failed for ${owner}/${repo}: ${error.message}`);
    entry.stars = null;
    entry.lastPush = null;
    entry.archived = false;
  }
}

async function enrichOfficialManifest(entry, owner, repo) {
  const urls = [
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/openpack.json`,
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/agentwheel.json`,
  ];

  for (const url of urls) {
    try {
      const manifest = await fetchJson(url);
      const provides = Array.isArray(manifest.provides)
        ? manifest.provides.map((item) => item?.type).filter((type) => typeof type === "string" && type)
        : [];
      entry.provides = [...new Set(provides)].sort();
      entry.version = typeof manifest.version === "string" && manifest.version ? manifest.version : null;
      return;
    } catch {
      // Try the fallback manifest name before warning.
    }
  }

  console.warn(`Official manifest enrichment failed for ${owner}/${repo}`);
  entry.provides = null;
  entry.version = null;
}

function officialEntry(entry) {
  const repo = repoFromSource(entry.source);
  return {
    id: `official:${entry.name}`,
    name: entry.name,
    ecosystem: "official",
    type: entry.type,
    description: entry.description,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    source: entry.source,
    installCommand: `npx agentwheel install ${entry.name}`,
    repoUrl: repo ? repoUrl(repo.owner, repo.repo) : null,
    homepageUrl: null,
    stars: null,
    lastPush: null,
    archived: false,
    provides: null,
    version: null,
    _repo: repo,
  };
}

function vercelEntry(seed) {
  return {
    id: `vercel:${seed.owner}/${seed.repo}/${seed.skill}`,
    name: seed.skill,
    ecosystem: "vercel",
    type: "skill",
    description: seed.description,
    tags: Array.isArray(seed.tags) ? seed.tags : [],
    source: `vercel:skills.sh/${seed.owner}/${seed.repo}/${seed.skill}`,
    installCommand: `npx agentwheel install "vercel:skills.sh/${seed.owner}/${seed.repo}/${seed.skill}"`,
    repoUrl: repoUrl(seed.owner, seed.repo),
    homepageUrl: `https://skills.sh/${seed.owner}/${seed.repo}/${seed.skill}`,
    stars: null,
    lastPush: null,
    archived: false,
    provides: null,
    version: null,
    featured: true,
    _repo: { owner: seed.owner, repo: seed.repo },
  };
}

function skillkitEntry(seed) {
  return {
    id: `skillkit:${seed.owner}/${seed.repo}`,
    name: seed.repo,
    ecosystem: "skillkit",
    type: "package",
    description: seed.description,
    tags: Array.isArray(seed.tags) ? seed.tags : [],
    source: `skillkit:github:${seed.owner}/${seed.repo}`,
    installCommand: `npx agentwheel install "skillkit:github:${seed.owner}/${seed.repo}"`,
    repoUrl: repoUrl(seed.owner, seed.repo),
    homepageUrl: null,
    stars: null,
    lastPush: null,
    archived: false,
    provides: null,
    version: null,
    _repo: { owner: seed.owner, repo: seed.repo },
  };
}

function skillkitMarketplaceEntry(source, seed) {
  const [owner, repo] = String(source.source || "").split("/");
  const official = Boolean(source.official);
  const tags = ["skillkit"];
  if (official) tags.push("official-source");
  if (seed?.tags) {
    for (const tag of seed.tags) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  return {
    id: `skillkit:${owner}/${repo}`,
    name: repo,
    ecosystem: "skillkit",
    type: "package",
    description: seed?.description ?? "",
    tags,
    source: `skillkit:github:${owner}/${repo}`,
    installCommand: `npx agentwheel install "skillkit:github:${owner}/${repo}"`,
    repoUrl: repoUrl(owner, repo),
    homepageUrl: null,
    stars: null,
    lastPush: null,
    archived: false,
    provides: null,
    version: null,
    _fallbackDescription: typeof source.name === "string" && source.name.trim() ? source.name.trim() : null,
    _repo: { owner, repo },
  };
}

async function openpackEntry(owner, repo, knownSources) {
  const source = githubSource(owner, repo);
  if (knownSources.has(sourceKey(source))) return null;
  const manifest = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/openpack.json`);
  if (!manifest || typeof manifest !== "object") return null;
  const provides = Array.isArray(manifest.provides)
    ? [...new Set(manifest.provides.map((item) => item?.type).filter((type) => typeof type === "string" && type))].sort()
    : [];
  if (provides.length === 0) return null;

  const entry = {
    id: `openpack:${owner}/${repo}`,
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : `${owner}/${repo}`,
    ecosystem: "openpack",
    type: "package",
    description: typeof manifest.description === "string" ? manifest.description : "",
    tags: ["openpack", ...provides],
    source,
    installCommand: `npx agentwheel install "${source}"`,
    repoUrl: repoUrl(owner, repo),
    homepageUrl: null,
    stars: null,
    lastPush: null,
    archived: false,
    provides,
    version: typeof manifest.version === "string" && manifest.version ? manifest.version : null,
    _repo: { owner, repo },
  };
  await enrichGitHub(entry, owner, repo);
  return entry.description ? entry : { ...entry, description: `OpenPack package from ${owner}/${repo}.` };
}

function existingEntriesFor(existing, ecosystem) {
  return (existing?.entries ?? [])
    .filter((entry) => entry?.ecosystem === ecosystem)
    .map((entry) => ecosystem === "mcp-registry" ? { ...entry, installCommand: mcpInstallCommand(entry.source) } : entry);
}

async function discoverOpenPackEntries(knownSources, existing) {
  const limit = normalizedCap(openpackCrawlCap, 100);
  if (limit === 0) return existingEntriesFor(existing, "openpack");
  if (!process.env.GITHUB_TOKEN) {
    console.warn("OpenPack GitHub code search skipped: GITHUB_TOKEN is not set");
    return existingEntriesFor(existing, "openpack");
  }

  const entries = [];
  const seenRepos = new Set();
  let page = 1;
  while (entries.length < limit) {
    const remaining = limit - entries.length;
    const perPage = Math.min(100, remaining);
    const query = encodeURIComponent("filename:openpack.json schemaVersion provides");
    const payload = await fetchJson(`${githubCodeSearchUrl}?q=${query}&per_page=${perPage}&page=${page}`);
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length === 0) break;
    for (const item of items) {
      const fullName = item?.repository?.full_name;
      if (!fullName || seenRepos.has(fullName)) continue;
      seenRepos.add(fullName);
      const [owner, repo] = fullName.split("/");
      if (!owner || !repo) continue;
      try {
        const entry = await openpackEntry(owner, repo, knownSources);
        if (entry) entries.push(entry);
      } catch (error) {
        console.warn(`OpenPack discovery failed for ${fullName}: ${error.message}`);
      }
      if (entries.length >= limit) break;
    }
    if (items.length < perPage) break;
    page += 1;
  }
  return entries;
}

function supportedMcpRemote(remotes) {
  for (const remote of remotes ?? []) {
    if (remote?.type !== "streamable-http") continue;
    if (typeof remote.url !== "string" || !/^https?:\/\//.test(remote.url)) continue;
    if ((remote.headers ?? []).some((header) => header?.isRequired && header?.isSecret)) continue;
    return remote;
  }
  return null;
}

function mcpInstallCommand(source) {
  return `npx agentwheel install "${source}" --adapter claude --local`;
}

function mcpRegistryEntry(server) {
  if (!server?.name || !supportedMcpRemote(server.remotes)) return null;
  const title = typeof server.title === "string" && server.title.trim() ? server.title.trim() : server.name;
  const description = typeof server.description === "string" && server.description.trim()
    ? server.description.trim()
    : `${title} MCP server from the public MCP Registry.`;
  const source = `mcp-registry:${server.name}`;
  const official = Boolean(server._meta?.["io.modelcontextprotocol.registry/official"]?.status);
  const repositoryUrl = typeof server.repository?.url === "string" ? server.repository.url : null;
  return {
    id: `mcp-registry:${server.name}`,
    name: title,
    ecosystem: "mcp-registry",
    type: "mcp",
    description,
    tags: official ? ["mcp", "registry", "official"] : ["mcp", "registry"],
    source,
    installCommand: mcpInstallCommand(source),
    repoUrl: repositoryUrl,
    homepageUrl: typeof server.websiteUrl === "string" ? server.websiteUrl : null,
    stars: null,
    lastPush: null,
    archived: false,
    provides: ["mcp"],
    version: typeof server.version === "string" && server.version ? server.version : null,
  };
}

function clawhubPluginSlug(item) {
  const name = String(item.name || "");
  if (name.startsWith("@") && name.includes("/")) {
    return name.slice(name.indexOf("/") + 1);
  }
  return name;
}

function clawhubPluginUrl(item) {
  const owner = String(item.ownerHandle || "").trim();
  const slug = clawhubPluginSlug(item).trim();
  if (!owner || !slug) return `https://clawhub.ai/plugins/${encodeURIComponent(String(item.name || ""))}`;
  return `https://clawhub.ai/${encodeURIComponent(owner)}/plugins/${encodeURIComponent(slug)}`;
}

function clawhubPluginEntry(item) {
  if (!item?.name || !["code-plugin", "bundle-plugin"].includes(item.family)) return null;
  const name = String(item.name).trim();
  if (!name) return null;
  const displayName = typeof item.displayName === "string" && item.displayName.trim() ? item.displayName.trim() : name;
  const categories = Array.isArray(item.categories) ? item.categories.filter((category) => typeof category === "string" && category) : [];
  const topics = Array.isArray(item.topics) ? item.topics.filter((topic) => typeof topic === "string" && topic) : [];
  const tags = [...new Set(["openclaw", "clawhub", item.family, item.channel, ...categories, ...topics].filter(Boolean))];
  const updatedAt = typeof item.updatedAt === "number" ? new Date(item.updatedAt).toISOString() : null;
  const stars = typeof item.stats?.stars === "number" ? item.stats.stars : null;
  const source = `clawhub:${name}`;
  return {
    id: `clawhub:${name}`,
    name: displayName,
    ecosystem: "clawhub",
    type: "plugin",
    description: typeof item.summary === "string" && item.summary.trim()
      ? item.summary.trim()
      : `${displayName} OpenClaw plugin from ClawHub.`,
    tags,
    source,
    installCommand: `npx agentwheel install "${source}" --adapter openclaw --local --only-source --execute-plugins`,
    repoUrl: null,
    homepageUrl: clawhubPluginUrl(item),
    homepageLinkLabel: "ClawHub",
    stars,
    lastPush: updatedAt,
    archived: false,
    provides: ["plugins"],
    version: typeof item.latestVersion === "string" && item.latestVersion ? item.latestVersion : null,
  };
}

async function discoverClawHubPluginEntries(existing) {
  const limit = normalizedCap(clawhubCrawlCap, 100);
  if (limit === 0) return existingEntriesFor(existing, "clawhub");
  const entries = [];
  const seen = new Set();
  let cursor = null;

  try {
    while (entries.length < limit) {
      const pageLimit = Math.min(100, limit - entries.length);
      const url = new URL(`${clawhubBaseUrl}/plugins`);
      url.searchParams.set("limit", String(pageLimit));
      if (cursor) url.searchParams.set("cursor", cursor);
      const payload = await fetchClawHubJson(url.toString());
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const item of items) {
        const entry = clawhubPluginEntry(item);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
        if (entries.length >= limit) break;
      }
      cursor = payload.nextCursor ?? payload.metadata?.nextCursor ?? null;
      if (!cursor || items.length === 0) break;
    }
    return entries;
  } catch (error) {
    console.warn(`ClawHub plugin discovery failed: ${error.message}`);
    return existingEntriesFor(existing, "clawhub");
  }
}

async function discoverMcpRegistryEntries(existing) {
  const limit = normalizedCap(mcpRegistryCrawlCap, 500);
  if (limit === 0) return existingEntriesFor(existing, "mcp-registry");
  const entries = [];
  const seen = new Set();
  let cursor = null;
  try {
    while (entries.length < limit) {
      const pageLimit = Math.min(100, limit - entries.length);
      const url = new URL(`${mcpRegistryBaseUrl}/servers`);
      url.searchParams.set("limit", String(pageLimit));
      if (cursor) url.searchParams.set("cursor", cursor);
      const payload = await fetchRegistryJson(url.toString());
      const servers = Array.isArray(payload.servers) ? payload.servers : [];
      for (const item of servers) {
        const server = item?.server ?? item;
        if (!server?.name || seen.has(server.name)) continue;
        const entry = mcpRegistryEntry(server);
        if (entry) {
          entries.push(entry);
          seen.add(server.name);
        }
        if (entries.length >= limit) break;
      }
      cursor = payload.metadata?.nextCursor ?? payload.nextCursor ?? null;
      if (!cursor || servers.length === 0) break;
    }
    return entries;
  } catch (error) {
    console.warn(`MCP registry discovery failed: ${error.message}`);
    return existingEntriesFor(existing, "mcp-registry");
  }
}

function sortEntries(entries) {
  entries.sort((a, b) => {
    const ecosystemDiff = ecosystemOrder.get(a.ecosystem) - ecosystemOrder.get(b.ecosystem);
    if (ecosystemDiff !== 0) return ecosystemDiff;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}

function validate(entries) {
  const errors = [];
  const ids = new Set();
  const requiredStrings = ["id", "name", "ecosystem", "type", "description", "source", "installCommand"];

  for (const entry of entries) {
    for (const field of requiredStrings) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        errors.push(`${entry.id || "(unknown)"}: ${field} must be a non-empty string`);
      }
    }
    if (!ecosystemSet.has(entry.ecosystem)) {
      errors.push(`${entry.id}: ecosystem must be one of ${[...ecosystemSet].join(", ")}`);
    }
    if (!entryTypeSet.has(entry.type)) {
      errors.push(`${entry.id}: type must be one of ${[...entryTypeSet].join(", ")}`);
    }
    if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")) {
      errors.push(`${entry.id}: tags must be an array of strings`);
    }
    if (entry.repoUrl !== null && (typeof entry.repoUrl !== "string" || !entry.repoUrl.trim())) {
      errors.push(`${entry.id}: repoUrl must be a non-empty string or null`);
    }
    if (ids.has(entry.id)) {
      errors.push(`${entry.id}: duplicate id`);
    }
    ids.add(entry.id);
  }

  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function validateVercelIndex(entries) {
  const errors = [];
  const ids = new Set();

  for (const entry of entries) {
    for (const field of ["o", "r", "s"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        errors.push(`${entry.o || "(unknown)"}/${entry.r || "(unknown)"}/${entry.s || "(unknown)"}: ${field} must be a non-empty string`);
      }
    }
    const id = `${entry.o}/${entry.r}/${entry.s}`;
    if (ids.has(id)) {
      errors.push(`${id}: duplicate Vercel index entry`);
    }
    if (entry.d !== undefined && (typeof entry.d !== "string" || !entry.d.trim())) {
      errors.push(`${id}: d must be a non-empty string when present`);
    }
    ids.add(id);
  }

  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function publicEntry(entry) {
  const { _fallbackDescription, _repo, ...rest } = entry;
  return rest;
}

function entriesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stableCatalogueEntry(entry) {
  const { lastPush, stars, ...stable } = entry;
  return stable;
}

function diffSummary(currentEntries, nextEntries) {
  const currentById = new Map((currentEntries ?? []).map((entry) => [entry.id, entry]));
  const nextById = new Map(nextEntries.map((entry) => [entry.id, entry]));
  const added = [...nextById.keys()].filter((id) => !currentById.has(id));
  const removed = [...currentById.keys()].filter((id) => !nextById.has(id));
  const changed = [...nextById.keys()].filter((id) => currentById.has(id) && !entriesEqual(currentById.get(id), nextById.get(id)));
  return `added: ${added.length}, removed: ${removed.length}, changed: ${changed.length}`;
}

async function build(existingCatalogue) {
  const registry = await readJson(path.join(root, "index.json"));
  const vercelSeeds = await readJson(path.join(root, "catalogue", "seeds", "vercel.json"));
  const skillkitSeeds = await readJson(path.join(root, "catalogue", "seeds", "skillkit.json"));
  const skillkitSeedMap = new Map((skillkitSeeds.entries ?? []).map((seed) => [`${seed.owner}/${seed.repo}`, seed]));
  const skillkitEntries = new Map();
  const knownOfficialSources = new Set((registry.entries ?? []).map((entry) => sourceKey(entry.source)));

  try {
    const skillkitSources = await fetchJson(skillkitSourcesUrl);
    const skillkitSourceEntries = Array.isArray(skillkitSources)
      ? skillkitSources
      : Array.isArray(skillkitSources?.sources)
        ? skillkitSources.sources
        : [];
    for (const source of skillkitSourceEntries) {
      if (!source?.source || !/^[^/\s]+\/[^/\s]+$/.test(source.source)) continue;
      const seed = skillkitSeedMap.get(source.source);
      const entry = skillkitMarketplaceEntry(source, seed);
      skillkitEntries.set(entry.id, entry);
    }
  } catch (error) {
    console.warn(`SkillKit marketplace sources refresh failed: ${error.message}`);
  }

  for (const seed of skillkitSeeds.entries ?? []) {
    const id = `skillkit:${seed.owner}/${seed.repo}`;
    if (!skillkitEntries.has(id)) {
      skillkitEntries.set(id, skillkitEntry(seed));
    }
  }

  const entries = [
    ...(Array.isArray(registry.entries) ? registry.entries.map(officialEntry) : []),
    ...await discoverOpenPackEntries(knownOfficialSources, existingCatalogue),
    ...await discoverMcpRegistryEntries(existingCatalogue),
    ...await discoverClawHubPluginEntries(existingCatalogue),
    ...skillkitEntries.values(),
    ...(Array.isArray(vercelSeeds.entries) ? vercelSeeds.entries.map(vercelEntry) : []),
  ];

  for (const entry of entries) {
    if (entry._repo) {
      await enrichGitHub(entry, entry._repo.owner, entry._repo.repo);
      if (!entry.description && entry._fallbackDescription) {
        entry.description = entry._fallbackDescription;
      }
      if (entry.ecosystem === "official") {
        await enrichOfficialManifest(entry, entry._repo.owner, entry._repo.repo);
      }
    } else {
      if (entry.ecosystem === "official") {
        console.warn(`No GitHub repository found for ${entry.id}`);
      }
      entry.stars = null;
      entry.lastPush = null;
      entry.archived = false;
      if (entry.ecosystem === "official") {
        entry.provides = null;
        entry.version = null;
      }
    }
  }

  const publicEntries = entries.map(publicEntry);
  sortEntries(publicEntries);

  if (!validate(publicEntries)) {
    return null;
  }

  return publicEntries;
}

async function crawlVercelDescriptions(entries) {
  const crawlLimit = normalizedCrawlCap();
  const missing = entries.filter((entry) => !entry.d);
  const cappedMissing = missing.slice(0, crawlLimit);

  async function crawlSlice(slice, onDescription) {
    let cursor = 0;
    let crawled = 0;
    let failed = 0;

    async function worker() {
      while (cursor < slice.length) {
        const entry = slice[cursor];
        cursor += 1;
        await sleep(crawlGapMs);
        try {
          const description = await fetchSkillDescription(`https://www.skills.sh/${entry.o}/${entry.r}/${entry.s}`);
          if (description) onDescription(entry, description);
        } catch (error) {
          failed += 1;
          console.warn(`Vercel description crawl failed for ${entry.o}/${entry.r}/${entry.s}: ${error.message}`);
        }
        crawled += 1;
      }
    }

    await Promise.all(Array.from({ length: Math.min(crawlConcurrency, slice.length) }, () => worker()));
    return { crawled, failed };
  }

  const missingResult = await crawlSlice(cappedMissing, (entry, description) => {
    entry.d = description;
  });
  const stillMissing = entries.filter((entry) => !entry.d).length;
  console.warn(`Vercel description crawl: crawled ${missingResult.crawled}, failed ${missingResult.failed}, still missing ${stillMissing}`);

  const refreshBudget = Math.max(0, crawlLimit - missingResult.crawled);
  let refreshed = 0;
  let refreshFailed = 0;
  let changed = 0;

  if (refreshBudget > 0) {
    const entriesWithD = entries.filter((entry) => entry.d);
    if (entriesWithD.length > 0) {
      const week = Math.floor(Date.now() / (7 * 86400000));
      const start = (week * refreshBudget) % entriesWithD.length;
      const refreshSlice = [];
      const refreshCount = Math.min(refreshBudget, entriesWithD.length);

      for (let index = 0; index < refreshCount; index += 1) {
        refreshSlice.push(entriesWithD[(start + index) % entriesWithD.length]);
      }

      const refreshResult = await crawlSlice(refreshSlice, (entry, description) => {
        if (description !== entry.d) {
          entry.d = description;
          changed += 1;
        }
      });
      refreshed = refreshResult.crawled;
      refreshFailed = refreshResult.failed;
    }
  }

  if (refreshFailed > 0) {
    console.warn(`Vercel description refresh failures: ${refreshFailed}`);
  }
  console.warn(`Vercel description refresh: refreshed ${refreshed}, changed ${changed}`);
}

async function buildVercelIndex(existingIndex) {
  if (!refreshVercelIndex) {
    console.warn("Vercel skills index refresh skipped by VERCEL_INDEX_REFRESH=0");
    return existingIndex?.entries ?? null;
  }
  try {
    const rootXml = await fetchText("https://www.skills.sh/sitemap.xml");
    const sitemapUrls = extractLocs(rootXml).filter((url) => /\/sitemap-skills-\d+\.xml$/.test(url));
    const records = new Map();
    const existingDescriptions = new Map((existingIndex?.entries ?? [])
      .filter((entry) => entry?.d)
      .map((entry) => [`${entry.o}/${entry.r}/${entry.s}`, entry.d]));
    let urlCount = 0;

    for (const sitemapUrl of sitemapUrls) {
      const sitemapXml = await fetchText(sitemapUrl);
      const skillUrls = extractLocs(sitemapXml);
      urlCount += skillUrls.length;

      for (const skillUrl of skillUrls) {
        const match = /^https:\/\/www\.skills\.sh\/([^/\s?#]+)\/([^/\s?#]+)\/([^/\s?#]+)$/.exec(skillUrl);
        if (!match) continue;
        const record = { o: match[1], r: match[2], s: match[3] };
        const description = existingDescriptions.get(`${record.o}/${record.r}/${record.s}`);
        if (description) record.d = description;
        records.set(`${record.o}/${record.r}/${record.s}`, record);
      }
    }

    const entries = [...records.values()].sort((a, b) => {
      if (a.o < b.o) return -1;
      if (a.o > b.o) return 1;
      if (a.r < b.r) return -1;
      if (a.r > b.r) return 1;
      if (a.s < b.s) return -1;
      if (a.s > b.s) return 1;
      return 0;
    });

    console.log(`Vercel skills index: found ${sitemapUrls.length} sitemap files and ${urlCount} URLs`);
    if (!validateVercelIndex(entries)) {
      return null;
    }
    if (!check) {
      await crawlVercelDescriptions(entries);
    }
    return entries;
  } catch (error) {
    console.warn(`Vercel skills index refresh failed: ${error.message}`);
    return null;
  }
}

const outputPath = path.join(root, "catalogue-data.json");
const vercelIndexPath = path.join(root, "catalogue-vercel-index.json");
const existing = await readJsonIfExists(outputPath);
const existingVercelIndex = await readJsonIfExists(vercelIndexPath);
const builtEntries = await build(existing);
if (!builtEntries) {
  process.exit();
}
const builtVercelIndexEntries = await buildVercelIndex(existingVercelIndex);

if (check) {
  let failed = false;
  if (!existing) {
    console.error("catalogue-data.json is missing");
    failed = true;
  } else if (!entriesEqual(existing.entries.map(stableCatalogueEntry), builtEntries.map(stableCatalogueEntry))) {
    console.error(`catalogue-data.json drift detected (${diffSummary(existing.entries.map(stableCatalogueEntry), builtEntries.map(stableCatalogueEntry))})`);
    failed = true;
  } else {
    console.log("catalogue-data.json is up to date");
  }

  if (builtVercelIndexEntries) {
    if (!existingVercelIndex) {
      console.error("catalogue-vercel-index.json is missing");
      failed = true;
    } else if (existingVercelIndex.count !== existingVercelIndex.entries?.length) {
      console.error("catalogue-vercel-index.json count does not match entries length");
      failed = true;
    } else if (!validateVercelIndex(existingVercelIndex.entries)) {
      failed = true;
    } else if (!entriesEqual(existingVercelIndex.entries, builtVercelIndexEntries)) {
      console.error(`catalogue-vercel-index.json drift detected (${diffSummary(existingVercelIndex.entries, builtVercelIndexEntries)})`);
      failed = true;
    } else {
      console.log("catalogue-vercel-index.json is up to date");
    }
  } else if (existingVercelIndex) {
    console.warn("catalogue-vercel-index.json check skipped because skills.sh sitemap refresh failed");
  } else {
    console.warn("catalogue-vercel-index.json is missing and skills.sh sitemap refresh failed");
  }

  if (failed) {
    process.exitCode = 1;
  }
  process.exit();
}

const generatedAt = existing && entriesEqual(existing.entries, builtEntries)
  ? existing.generatedAt
  : new Date().toISOString();
const output = {
  schemaVersion: 1,
  generatedAt,
  entries: builtEntries,
};

await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);

if (builtVercelIndexEntries) {
  const vercelIndexGeneratedAt = existingVercelIndex && entriesEqual(existingVercelIndex.entries, builtVercelIndexEntries)
    ? existingVercelIndex.generatedAt
    : new Date().toISOString();
  const vercelIndexOutput = {
    schemaVersion: 1,
    generatedAt: vercelIndexGeneratedAt,
    count: builtVercelIndexEntries.length,
    entries: builtVercelIndexEntries,
  };
  await fs.writeFile(vercelIndexPath, `${JSON.stringify(vercelIndexOutput, null, 2)}\n`);
}
