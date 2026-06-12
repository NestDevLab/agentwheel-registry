import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const check = process.argv.includes("--check");
const ecosystemOrder = new Map([
  ["official", 0],
  ["skillkit", 1],
  ["vercel", 2],
]);
const entryTypeSet = new Set(["package", "skill", "plugin", "mcp", "adapter"]);
const ecosystemSet = new Set(ecosystemOrder.keys());
const crawlCap = Number.parseInt(process.env.CRAWL_CAP ?? "5000", 10);
const skillkitSourcesUrl = "https://raw.githubusercontent.com/rohitg00/skillkit/main/marketplace/sources.json";
const crawlConcurrency = 4;
const crawlGapMs = 40;

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

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchSkillPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      "User-Agent": "agentwheel-catalogue (github.com/NestDevLab/agentwheel-registry)",
    },
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
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

async function build() {
  const registry = await readJson(path.join(root, "index.json"));
  const vercelSeeds = await readJson(path.join(root, "catalogue", "seeds", "vercel.json"));
  const skillkitSeeds = await readJson(path.join(root, "catalogue", "seeds", "skillkit.json"));
  const skillkitSeedMap = new Map((skillkitSeeds.entries ?? []).map((seed) => [`${seed.owner}/${seed.repo}`, seed]));
  const skillkitEntries = new Map();

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
      console.warn(`No GitHub repository found for ${entry.id}`);
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
          const html = await fetchSkillPage(`https://www.skills.sh/${entry.o}/${entry.r}/${entry.s}`);
          const description = extractMetaDescription(html);
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
const builtEntries = await build();
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
