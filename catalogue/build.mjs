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

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]);
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
  const { _repo, ...rest } = entry;
  return rest;
}

function entriesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

  const entries = [
    ...(Array.isArray(registry.entries) ? registry.entries.map(officialEntry) : []),
    ...(Array.isArray(skillkitSeeds.entries) ? skillkitSeeds.entries.map(skillkitEntry) : []),
    ...(Array.isArray(vercelSeeds.entries) ? vercelSeeds.entries.map(vercelEntry) : []),
  ];

  for (const entry of entries) {
    if (entry._repo) {
      await enrichGitHub(entry, entry._repo.owner, entry._repo.repo);
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

async function buildVercelIndex() {
  try {
    const rootXml = await fetchText("https://www.skills.sh/sitemap.xml");
    const sitemapUrls = extractLocs(rootXml).filter((url) => /\/sitemap-skills-\d+\.xml$/.test(url));
    const records = new Map();
    let urlCount = 0;

    for (const sitemapUrl of sitemapUrls) {
      const sitemapXml = await fetchText(sitemapUrl);
      const skillUrls = extractLocs(sitemapXml);
      urlCount += skillUrls.length;

      for (const skillUrl of skillUrls) {
        const match = /^https:\/\/www\.skills\.sh\/([^/\s?#]+)\/([^/\s?#]+)\/([^/\s?#]+)$/.exec(skillUrl);
        if (!match) continue;
        const record = { o: match[1], r: match[2], s: match[3] };
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
    return entries;
  } catch (error) {
    console.warn(`Vercel skills index refresh failed: ${error.message}`);
    return null;
  }
}

const builtEntries = await build();
if (!builtEntries) {
  process.exit();
}
const builtVercelIndexEntries = await buildVercelIndex();

const outputPath = path.join(root, "catalogue-data.json");
const vercelIndexPath = path.join(root, "catalogue-vercel-index.json");
const existing = await readJsonIfExists(outputPath);
const existingVercelIndex = await readJsonIfExists(vercelIndexPath);

if (check) {
  let failed = false;
  if (!existing) {
    console.error("catalogue-data.json is missing");
    failed = true;
  } else if (!entriesEqual(existing.entries, builtEntries)) {
    console.error(`catalogue-data.json drift detected (${diffSummary(existing.entries, builtEntries)})`);
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
