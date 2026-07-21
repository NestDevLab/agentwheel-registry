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
const readmeExcerptLimit = 1200;
const documentationCache = new Map();
const refreshStatePath = path.join(root, "catalogue", "refresh-state.json");
const providerFailures = new Map();
const fetchTimeoutMs = Number.parseInt(process.env.FETCH_TIMEOUT_MS ?? "8000", 10);
const mcpRegistryFetchTimeoutMs = Number.parseInt(process.env.MCP_REGISTRY_FETCH_TIMEOUT_MS ?? "30000", 10);

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

function refreshState(value) {
  return {
    schemaVersion: 1,
    cursors: value?.cursors && typeof value.cursors === "object" ? value.cursors : {},
    providers: {},
  };
}

function providerSucceeded(name, state) {
  state.providers[name] = { status: "ok", checkedAt: new Date().toISOString() };
}

function providerFailed(name, state, error) {
  const message = error instanceof Error ? error.message : String(error);
  providerFailures.set(name, message);
  state.providers[name] = { status: "failed", checkedAt: new Date().toISOString(), error: message };
}

async function fetchBounded(url, options = {}, timeoutMs = fetchTimeoutMs) {
  const controller = new AbortController();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timeout);
  }
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

  const response = await fetchBounded(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchRegistryJson(url) {
  await sleep(100);
  const response = await fetchBounded(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "agentwheel-catalogue (github.com/NestDevLab/agentwheel-registry)",
    },
  }, mcpRegistryFetchTimeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchClawHubJson(url) {
  await sleep(100);
  const response = await fetchBounded(url, {
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
  const response = await fetchBounded(url);
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

function sourceRef(source) {
  const ref = String(source || "").split("#", 2)[1];
  return ref || "main";
}

function encodePathSegment(value) {
  return String(value).split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function selectedSkillName(entry) {
  if (Array.isArray(entry.skills) && entry.skills.length === 1 && typeof entry.skills[0] === "string") {
    return entry.skills[0];
  }
  if (Array.isArray(entry.select) && entry.select.length === 1 && typeof entry.select[0] === "string") {
    const match = /^skills\/(.+)$/.exec(entry.select[0]);
    if (match) return match[1];
  }
  return null;
}

function selectedArtifactSelectors(entry) {
  const selectors = [];
  if (Array.isArray(entry.select)) {
    for (const selector of entry.select) {
      if (typeof selector === "string" && selector.trim()) selectors.push(selector.trim());
    }
  }
  if (Array.isArray(entry.skills)) {
    for (const skill of entry.skills) {
      if (typeof skill === "string" && skill.trim()) selectors.push(`skills/${skill.trim()}`);
    }
  }
  return [...new Set(selectors)];
}

function selectedNameFromSelectors(selectors, type) {
  if (!Array.isArray(selectors) || selectors.length !== 1) return null;
  const match = new RegExp(`^${type}/(.+)$`).exec(selectors[0]);
  return match ? match[1] : null;
}

function sourceUrlForRegistryEntry(entry, repo) {
  if (typeof entry.sourceUrl === "string" && entry.sourceUrl.trim()) return entry.sourceUrl.trim();
  const skill = selectedSkillName(entry);
  if (!repo || !skill) return null;
  return `${repoUrl(repo.owner, repo.repo)}/tree/${encodePathSegment(sourceRef(entry.source))}/skills/${encodePathSegment(skill)}`;
}

function sourceUrlForSource(source, selectors) {
  if (typeof source !== "string" || !source.trim()) return null;
  const skill = selectedNameFromSelectors(selectors, "skills");
  const vercelMatch = /^vercel:skills\.sh\/([^/\s#]+)\/([^/\s#]+)(?:\/([^/\s#]+))?(?:#.*)?$/.exec(source);
  if (vercelMatch) {
    const sourceSkill = vercelMatch[3] || skill;
    if (sourceSkill) return `https://skills.sh/${vercelMatch[1]}/${vercelMatch[2]}/${encodeURIComponent(sourceSkill)}`;
    return `https://skills.sh/${vercelMatch[1]}/${vercelMatch[2]}`;
  }

  const githubRepo = repoFromSource(source);
  if (githubRepo && skill) {
    return `${repoUrl(githubRepo.owner, githubRepo.repo)}/tree/${encodePathSegment(sourceRef(source))}/skills/${encodePathSegment(skill)}`;
  }

  return null;
}

function sourceInstallCommand(source, selectors) {
  if (typeof source !== "string" || !source.trim()) return null;
  const skill = selectedNameFromSelectors(selectors, "skills");
  return skill
    ? `npx agentwheel install "${source}" --skill ${skill}`
    : `npx agentwheel install "${source}"`;
}

function sourceKey(source) {
  return String(source || "").replace(/#.*$/, "").replace(/^git:https:\/\/github\.com\//, "github:").replace(/\.git$/, "").toLowerCase();
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanStringArray(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
    : [];
}

function normalizeDependency(name, dependency) {
  if (!dependency || typeof dependency !== "object") return null;
  const source = cleanString(dependency.source);
  if (!source) return null;
  const selectors = cleanStringArray(dependency.select);
  return {
    name,
    source,
    select: selectors.length ? selectors : undefined,
    optional: dependency.optional === true,
    ref: cleanString(dependency.ref) ?? undefined,
    version: cleanString(dependency.version) ?? undefined,
    mode: cleanString(dependency.mode) ?? undefined,
    runtimes: cleanStringArray(dependency.runtimes).length ? cleanStringArray(dependency.runtimes) : undefined,
    sourceUrl: sourceUrlForSource(source, selectors) ?? undefined,
    installCommand: sourceInstallCommand(source, selectors) ?? undefined,
  };
}

function normalizeDependencies(requires) {
  if (!requires || typeof requires !== "object" || Array.isArray(requires)) return [];
  return Object.entries(requires)
    .map(([name, dependency]) => normalizeDependency(name, dependency))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function artifactSourcePath(provide, artifactName) {
  const basePath = cleanString(provide?.path);
  if (!basePath) return null;
  return `${basePath.replace(/\/+$/, "")}/${artifactName}`;
}

function artifactSourceUrl(repo, ref, sourcePath) {
  if (!repo || !sourcePath) return null;
  return `${repoUrl(repo.owner, repo.repo)}/tree/${encodePathSegment(ref)}/${encodePathSegment(sourcePath)}`;
}

function artifactFileUrl(repo, ref, filePath) {
  if (!repo || !filePath) return null;
  return `${repoUrl(repo.owner, repo.repo)}/blob/${encodePathSegment(ref)}/${encodePathSegment(filePath)}`;
}

function artifactRawUrl(repo, ref, filePath) {
  if (!repo || !filePath) return null;
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodePathSegment(ref)}/${encodePathSegment(filePath)}`;
}

function markdownExcerpt(markdown) {
  const withoutFrontmatter = String(markdown || "").replace(/^---\s*[\s\S]*?\s*---\s*/, "");
  const lines = withoutFrontmatter
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+\S+/.test(line))
    .filter((line) => !/^[-*_]{3,}$/.test(line));
  const textValue = lines
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (textValue.length <= readmeExcerptLimit) return textValue;
  return `${textValue.slice(0, readmeExcerptLimit - 1).trimEnd()}…`;
}

async function fetchArtifactDocumentation(repo, ref, artifact) {
  if (!repo || artifact.type !== "skills" || !artifact.sourcePath) return null;
  const candidates = [
    { filename: "README.md", title: "README" },
    { filename: "readme.md", title: "README" },
    { filename: "SKILL.md", title: "Skill guide" },
  ];

  for (const candidate of candidates) {
    const filePath = `${artifact.sourcePath.replace(/\/+$/, "")}/${candidate.filename}`;
    const rawUrl = artifactRawUrl(repo, ref, filePath);
    if (!rawUrl) continue;
    if (!documentationCache.has(rawUrl)) {
      documentationCache.set(rawUrl, fetchText(rawUrl).catch(() => null));
    }
    const markdown = await documentationCache.get(rawUrl);
    if (!markdown) continue;
    const excerpt = markdownExcerpt(markdown);
    if (!excerpt) continue;
    return {
      readmeTitle: candidate.title,
      readmeUrl: artifactFileUrl(repo, ref, filePath) ?? undefined,
      readmeExcerpt: excerpt,
    };
  }

  return null;
}

async function enrichArtifactDocumentation(artifacts, repo, ref) {
  for (const artifact of artifacts) {
    const documentation = await fetchArtifactDocumentation(repo, ref, artifact);
    if (documentation) Object.assign(artifact, documentation);
  }
}

function normalizeRequirement(value) {
  if (typeof value === "string" && value.trim()) {
    return { selector: value.trim() };
  }
  if (!value || typeof value !== "object") return null;
  const selector = cleanString(value.selector) ?? cleanString(value.name) ?? cleanString(value.source);
  if (!selector) return null;
  return {
    selector,
    optional: value.optional === true,
    source: cleanString(value.source) ?? undefined,
    runtimes: cleanStringArray(value.runtimes).length ? cleanStringArray(value.runtimes) : undefined,
  };
}

function normalizeRequirementArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(normalizeRequirement).filter(Boolean);
}

function manifestItemSelectors(entry, manifest) {
  const selected = selectedArtifactSelectors(entry);
  if (selected.length) return selected;
  if (entry.type !== "package" || !Array.isArray(manifest.provides)) return [];

  const selectors = [];
  for (const provide of manifest.provides) {
    if (!provide || typeof provide !== "object" || !provide.items || typeof provide.items !== "object") continue;
    for (const itemName of Object.keys(provide.items)) {
      selectors.push(`${provide.type}/${itemName}`);
    }
  }
  return [...new Set(selectors)];
}

function artifactMetadataForManifest(entry, manifest, repo) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.provides)) return [];
  const selectors = manifestItemSelectors(entry, manifest);
  const ref = sourceRef(entry.source);
  const artifacts = [];

  for (const selector of selectors) {
    const [type, ...nameParts] = selector.split("/");
    const name = nameParts.join("/");
    if (!type || !name) continue;
    const provide = manifest.provides.find((candidate) => candidate?.type === type);
    const item = provide?.items && typeof provide.items === "object" ? provide.items[name] : null;
    const sourcePath = artifactSourcePath(provide, name);
    const runtimes = cleanStringArray(item?.runtimes).length ? cleanStringArray(item.runtimes) : cleanStringArray(provide?.runtimes);
    const requires = normalizeRequirementArray(item?.requires);
    const compose = normalizeRequirementArray(item?.compose);
    const suggests = cleanStringArray(item?.suggests);

    artifacts.push({
      selector,
      type,
      name,
      format: cleanString(item?.format) ?? cleanString(provide?.format) ?? undefined,
      required: provide?.required === true || item?.required === true ? true : undefined,
      runtimes: runtimes.length ? runtimes : undefined,
      requires: requires.length ? requires : undefined,
      compose: compose.length ? compose : undefined,
      suggests: suggests.length ? suggests : undefined,
      sourcePath: sourcePath ?? undefined,
      sourceUrl: artifactSourceUrl(repo, ref, sourcePath) ?? undefined,
    });
  }

  return artifacts;
}

function normalizeSuggestedSkill(name, suggestion) {
  const source = cleanString(suggestion?.source);
  const selectors = cleanStringArray(suggestion?.select);
  return {
    name,
    relation: cleanString(suggestion?.relation) ?? "suggested",
    source: source ?? undefined,
    select: selectors.length ? selectors : undefined,
    reason: cleanString(suggestion?.reason) ?? undefined,
    when: cleanString(suggestion?.when) ?? undefined,
    sourceUrl: source ? sourceUrlForSource(source, selectors) ?? undefined : undefined,
    installCommand: source ? sourceInstallCommand(source, selectors) ?? undefined : undefined,
  };
}

function suggestedSkillsForEntry(entry, manifest, artifacts) {
  const names = new Set();
  for (const artifact of artifacts) {
    for (const name of artifact.suggests ?? []) names.add(name);
  }
  if (entry.type === "package" && names.size === 0 && manifest?.suggests && typeof manifest.suggests === "object") {
    for (const name of Object.keys(manifest.suggests)) names.add(name);
  }
  if (Array.isArray(entry.suggestedSkills)) {
    for (const item of entry.suggestedSkills) {
      if (typeof item === "string" && item.trim()) names.add(item.trim());
      if (item && typeof item === "object" && typeof item.name === "string" && item.name.trim()) names.add(item.name.trim());
    }
  }

  const suggestions = [];
  for (const name of [...names].sort()) {
    const manifestSuggestion = manifest?.suggests?.[name];
    const registrySuggestion = Array.isArray(entry.suggestedSkills)
      ? entry.suggestedSkills.find((item) => item && typeof item === "object" && item.name === name)
      : null;
    suggestions.push(normalizeSuggestedSkill(name, registrySuggestion ?? manifestSuggestion ?? {}));
  }
  return suggestions;
}

function normalizeRegistrySuggestedSkills(values) {
  if (!Array.isArray(values)) return undefined;
  const suggestions = values
    .map((item) => {
      if (typeof item === "string" && item.trim()) {
        return normalizeSuggestedSkill(item.trim(), {});
      }
      if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) return null;
      return normalizeSuggestedSkill(item.name.trim(), item);
    })
    .filter(Boolean);
  return suggestions.length ? suggestions : undefined;
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
    return true;
  } catch (error) {
    console.warn(`GitHub enrichment failed for ${owner}/${repo}: ${error.message}`);
    entry.stars = null;
    entry.lastPush = null;
    entry.archived = false;
    return false;
  }
}

function skillFrontmatter(text, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const value = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(match[1])?.[1]?.trim();
  if (!value) return null;
  return value.replace(/^(?:["'])(.*)(?:["'])$/, "$1");
}

async function officialSkillMetadata(repo, ref) {
  const tree = await fetchJson(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const paths = (Array.isArray(tree.tree) ? tree.tree : [])
    .filter((item) => item?.type === "blob" && /^skills\/[^/]+\/SKILL\.md$/.test(item.path))
    .map((item) => item.path)
    .sort();
  const skills = [];
  for (const skillFilePath of paths) {
    const name = /^skills\/([^/]+)\/SKILL\.md$/.exec(skillFilePath)?.[1];
    if (!name) continue;
    const sourcePath = `skills/${name}`;
    const rawUrl = artifactRawUrl(repo, ref, skillFilePath);
    const text = rawUrl ? await fetchText(rawUrl) : "";
    skills.push({
      selector: `skills/${name}`,
      type: "skills",
      name,
      description: skillFrontmatter(text, "description") ?? `Public skill ${name}.`,
      sourcePath,
      sourceUrl: artifactSourceUrl(repo, ref, skillFilePath) ?? undefined,
    });
  }
  return skills;
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
      const dependencies = entry._exposeDependencies ? normalizeDependencies(manifest.requires) : [];
      entry.dependencies = dependencies.length ? dependencies : undefined;
      const artifacts = artifactMetadataForManifest(entry, manifest, { owner, repo });
      const skills = await officialSkillMetadata({ owner, repo }, sourceRef(entry.source));
      const artifactBySelector = new Map(artifacts.map((artifact) => [artifact.selector, artifact]));
      for (const skill of skills) {
        artifactBySelector.set(skill.selector, { ...artifactBySelector.get(skill.selector), ...skill });
      }
      const mergedArtifacts = [...artifactBySelector.values()];
      await enrichArtifactDocumentation(mergedArtifacts, { owner, repo }, sourceRef(entry.source));
      entry.artifactMetadata = mergedArtifacts.length ? mergedArtifacts : undefined;
      const entryDocumentation = mergedArtifacts.find((artifact) => artifact.readmeExcerpt);
      entry.readmeTitle = entryDocumentation?.readmeTitle;
      entry.readmeUrl = entryDocumentation?.readmeUrl;
      entry.readmeExcerpt = entryDocumentation?.readmeExcerpt;
      const suggestions = suggestedSkillsForEntry(entry, manifest, mergedArtifacts);
      entry.suggestedSkills = suggestions.length ? suggestions : undefined;
      return true;
    } catch {
      // Try the fallback manifest name before warning.
    }
  }

  console.warn(`Official manifest enrichment failed for ${owner}/${repo}`);
  entry.provides = null;
  entry.version = null;
  entry.dependencies = undefined;
  entry.artifactMetadata = undefined;
  entry.readmeTitle = undefined;
  entry.readmeUrl = undefined;
  entry.readmeExcerpt = undefined;
  return false;
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
    select: Array.isArray(entry.select) ? entry.select : undefined,
    skills: Array.isArray(entry.skills) ? entry.skills : undefined,
    suggestedSkills: normalizeRegistrySuggestedSkills(entry.suggestedSkills),
    source: entry.source,
    installCommand: `npx agentwheel install ${entry.name}`,
    repoUrl: repo ? repoUrl(repo.owner, repo.repo) : null,
    homepageUrl: typeof entry.homepageUrl === "string" && entry.homepageUrl.trim() ? entry.homepageUrl.trim() : null,
    homepageLinkLabel: typeof entry.homepageLinkLabel === "string" && entry.homepageLinkLabel.trim() ? entry.homepageLinkLabel.trim() : undefined,
    sourceUrl: sourceUrlForRegistryEntry(entry, repo) ?? undefined,
    sourceLinkLabel: typeof entry.sourceLinkLabel === "string" && entry.sourceLinkLabel.trim() ? entry.sourceLinkLabel.trim() : undefined,
    stars: null,
    lastPush: null,
    archived: false,
    provides: null,
    version: null,
    _exposeDependencies: entry.exposeDependencies === true,
    _repo: repo,
  };
}

function officialSkillEntries(entry) {
  if (entry.ecosystem !== "official" || entry.type !== "package") return [];
  return (entry.artifactMetadata ?? [])
    .filter((artifact) => artifact?.type === "skills" && typeof artifact.name === "string" && artifact.name)
    .map((artifact) => ({
      id: `${entry.id}:${artifact.selector}`,
      name: artifact.name,
      ecosystem: "official",
      type: "skill",
      description: artifact.description ?? `Public skill ${artifact.name}.`,
      tags: [...new Set([...(entry.tags ?? []), "skill", "official"])],
      source: entry.source,
      select: [artifact.selector],
      installCommand: `npx agentwheel install ${entry.name} --select ${artifact.selector}`,
      repoUrl: entry.repoUrl,
      sourceUrl: artifact.sourceUrl,
      readmeTitle: artifact.readmeTitle,
      readmeUrl: artifact.readmeUrl,
      readmeExcerpt: artifact.readmeExcerpt,
      stars: entry.stars,
      lastPush: entry.lastPush,
      archived: entry.archived,
      provides: ["skills"],
      version: entry.version,
    }));
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

async function discoverOpenPackEntries(knownSources, existing, state) {
  const limit = normalizedCap(openpackCrawlCap, 100);
  if (limit === 0) return existingEntriesFor(existing, "openpack");
  if (!process.env.GITHUB_TOKEN) {
    console.warn("OpenPack GitHub code search skipped: GITHUB_TOKEN is not set");
    return existingEntriesFor(existing, "openpack");
  }

  const entries = new Map(existingEntriesFor(existing, "openpack").map((entry) => [entry.id, entry]));
  const seenRepos = new Set();
  const page = Number.isInteger(state.cursors.openpackPage) && state.cursors.openpackPage > 0
    ? state.cursors.openpackPage
    : 1;
  let found = 0;
  try {
    while (found < limit) {
      const remaining = limit - found;
      const perPage = Math.min(100, remaining);
      const query = encodeURIComponent("filename:openpack.json schemaVersion provides");
      const payload = await fetchJson(`${githubCodeSearchUrl}?q=${query}&per_page=${perPage}&page=${page}`);
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) {
        state.cursors.openpackPage = 1;
        break;
      }
      for (const item of items) {
        const fullName = item?.repository?.full_name;
        if (!fullName || seenRepos.has(fullName)) continue;
        seenRepos.add(fullName);
        const [owner, repo] = fullName.split("/");
        if (!owner || !repo) continue;
        try {
          const entry = await openpackEntry(owner, repo, knownSources);
          if (entry) {
            entries.set(entry.id, entry);
            found += 1;
          }
        } catch (error) {
          console.warn(`OpenPack discovery failed for ${fullName}: ${error.message}`);
        }
        if (found >= limit) break;
      }
      state.cursors.openpackPage = items.length < perPage ? 1 : page + 1;
      break;
    }
    providerSucceeded("openpack", state);
    return [...entries.values()];
  } catch (error) {
    console.warn(`OpenPack GitHub code search failed: ${error.message}`);
    providerFailed("openpack", state, error);
    return existingEntriesFor(existing, "openpack");
  }
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

async function discoverClawHubPluginEntries(existing, state) {
  const limit = normalizedCap(clawhubCrawlCap, 100);
  if (limit === 0) return existingEntriesFor(existing, "clawhub");
  const entries = new Map(existingEntriesFor(existing, "clawhub").map((entry) => [entry.id, entry]));
  const seen = new Set();
  let cursor = typeof state.cursors.clawhub === "string" ? state.cursors.clawhub : null;
  let processed = 0;

  try {
    while (processed < limit) {
      const pageLimit = Math.min(100, limit - processed);
      const url = new URL(`${clawhubBaseUrl}/plugins`);
      url.searchParams.set("limit", String(pageLimit));
      if (cursor) url.searchParams.set("cursor", cursor);
      const payload = await fetchClawHubJson(url.toString());
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const item of items) {
        const entry = clawhubPluginEntry(item);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.set(entry.id, entry);
        processed += 1;
        if (processed >= limit) break;
      }
      cursor = payload.nextCursor ?? payload.metadata?.nextCursor ?? null;
      if (!cursor || items.length === 0) {
        cursor = null;
        break;
      }
    }
    state.cursors.clawhub = cursor;
    providerSucceeded("clawhub", state);
    return [...entries.values()];
  } catch (error) {
    console.warn(`ClawHub plugin discovery failed: ${error.message}`);
    providerFailed("clawhub", state, error);
    return existingEntriesFor(existing, "clawhub");
  }
}

async function discoverMcpRegistryEntries(existing, state) {
  const limit = normalizedCap(mcpRegistryCrawlCap, 500);
  if (limit === 0) return existingEntriesFor(existing, "mcp-registry");
  const entries = new Map(existingEntriesFor(existing, "mcp-registry").map((entry) => [entry.id, entry]));
  const seen = new Set();
  let cursor = typeof state.cursors.mcpRegistry === "string" ? state.cursors.mcpRegistry : null;
  let processed = 0;
  try {
    while (processed < limit) {
      const pageLimit = Math.min(100, limit - processed);
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
          entries.set(entry.id, entry);
          seen.add(server.name);
          processed += 1;
        }
        if (processed >= limit) break;
      }
      cursor = payload.metadata?.nextCursor ?? payload.nextCursor ?? null;
      if (!cursor || servers.length === 0) {
        cursor = null;
        break;
      }
    }
    state.cursors.mcpRegistry = cursor;
    providerSucceeded("mcp-registry", state);
    return [...entries.values()];
  } catch (error) {
    console.warn(`MCP registry discovery failed: ${error.message}`);
    providerFailed("mcp-registry", state, error);
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
    for (const field of ["homepageUrl", "sourceUrl"]) {
      if (entry[field] !== undefined && entry[field] !== null && (typeof entry[field] !== "string" || !entry[field].trim())) {
        errors.push(`${entry.id}: ${field} must be a non-empty string, null, or omitted`);
      }
    }
    for (const field of ["readmeTitle", "readmeUrl", "readmeExcerpt"]) {
      if (entry[field] !== undefined && (typeof entry[field] !== "string" || !entry[field].trim())) {
        errors.push(`${entry.id}: ${field} must be a non-empty string when present`);
      }
    }
    for (const field of ["select", "skills"]) {
      if (entry[field] !== undefined && (!Array.isArray(entry[field]) || entry[field].some((value) => typeof value !== "string" || !value.trim()))) {
        errors.push(`${entry.id}: ${field} must be an array of non-empty strings when present`);
      }
    }
    for (const field of ["dependencies", "artifactMetadata", "suggestedSkills"]) {
      if (entry[field] !== undefined && !Array.isArray(entry[field])) {
        errors.push(`${entry.id}: ${field} must be an array when present`);
      }
    }
    if (Array.isArray(entry.dependencies)) {
      for (const dependency of entry.dependencies) {
        if (!dependency || typeof dependency.name !== "string" || typeof dependency.source !== "string") {
          errors.push(`${entry.id}: dependencies entries must include name and source strings`);
        }
      }
    }
    if (Array.isArray(entry.artifactMetadata)) {
      for (const artifact of entry.artifactMetadata) {
        if (!artifact || typeof artifact.selector !== "string" || typeof artifact.type !== "string" || typeof artifact.name !== "string") {
          errors.push(`${entry.id}: artifactMetadata entries must include selector, type, and name strings`);
        }
        for (const field of ["readmeTitle", "readmeUrl", "readmeExcerpt"]) {
          if (artifact?.[field] !== undefined && (typeof artifact[field] !== "string" || !artifact[field].trim())) {
            errors.push(`${entry.id}: artifactMetadata.${field} must be a non-empty string when present`);
          }
        }
      }
    }
    if (Array.isArray(entry.suggestedSkills)) {
      for (const suggestion of entry.suggestedSkills) {
        if (!suggestion || typeof suggestion.name !== "string" || !suggestion.name.trim()) {
          errors.push(`${entry.id}: suggestedSkills entries must include a name string`);
        }
      }
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
  const { _exposeDependencies, _fallbackDescription, _repo, ...rest } = entry;
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

async function build(existingCatalogue, state) {
  const registry = await readJson(path.join(root, "index.json"));
  const existingById = new Map((existingCatalogue?.entries ?? []).map((entry) => [entry.id, entry]));
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
    providerSucceeded("skillkit", state);
  } catch (error) {
    console.warn(`SkillKit marketplace sources refresh failed: ${error.message}`);
    providerFailed("skillkit", state, error);
  }

  for (const seed of skillkitSeeds.entries ?? []) {
    const id = `skillkit:${seed.owner}/${seed.repo}`;
    if (!skillkitEntries.has(id)) {
      skillkitEntries.set(id, skillkitEntry(seed));
    }
  }

  const entries = [
    ...(Array.isArray(registry.entries) ? registry.entries.map(officialEntry) : []),
    ...await discoverOpenPackEntries(knownOfficialSources, existingCatalogue, state),
    ...await discoverMcpRegistryEntries(existingCatalogue, state),
    ...await discoverClawHubPluginEntries(existingCatalogue, state),
    ...skillkitEntries.values(),
    ...(Array.isArray(vercelSeeds.entries) ? vercelSeeds.entries.map(vercelEntry) : []),
  ];

  for (const entry of entries) {
    if (entry._repo) {
      const previous = existingById.get(entry.id);
      const githubEnriched = await enrichGitHub(entry, entry._repo.owner, entry._repo.repo);
      if (!githubEnriched && previous) {
        entry.stars = previous.stars ?? null;
        entry.lastPush = previous.lastPush ?? null;
        entry.archived = Boolean(previous.archived);
      }
      if (!entry.description && entry._fallbackDescription) {
        entry.description = entry._fallbackDescription;
      }
      if (!githubEnriched && previous?.description && (!entry.description || entry.description === entry._fallbackDescription)) {
        entry.description = previous.description;
      }
      if (entry.ecosystem === "official") {
        const manifestEnriched = await enrichOfficialManifest(entry, entry._repo.owner, entry._repo.repo);
        if (!manifestEnriched && previous) {
          entry.provides = Array.isArray(previous.provides) ? previous.provides : null;
          entry.version = typeof previous.version === "string" ? previous.version : null;
          entry.dependencies = entry._exposeDependencies && Array.isArray(previous.dependencies) ? previous.dependencies : undefined;
          entry.artifactMetadata = Array.isArray(previous.artifactMetadata) ? previous.artifactMetadata : undefined;
          entry.suggestedSkills = Array.isArray(previous.suggestedSkills) ? previous.suggestedSkills : entry.suggestedSkills;
          entry.readmeTitle = typeof previous.readmeTitle === "string" ? previous.readmeTitle : undefined;
          entry.readmeUrl = typeof previous.readmeUrl === "string" ? previous.readmeUrl : undefined;
          entry.readmeExcerpt = typeof previous.readmeExcerpt === "string" ? previous.readmeExcerpt : undefined;
        }
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

  const publicEntries = [...entries, ...entries.flatMap(officialSkillEntries)].map(publicEntry);
  sortEntries(publicEntries);

  if (!validate(publicEntries)) {
    return null;
  }

  return publicEntries;
}

function circularSlice(entries, start, limit) {
  if (!entries.length || limit <= 0) return { entries: [], next: 0 };
  const count = Math.min(limit, entries.length);
  const offset = ((start % entries.length) + entries.length) % entries.length;
  return {
    entries: Array.from({ length: count }, (_, index) => entries[(offset + index) % entries.length]),
    next: (offset + count) % entries.length,
  };
}

async function crawlVercelDescriptions(entries, state) {
  const crawlLimit = normalizedCrawlCap();
  const missing = entries.filter((entry) => !entry.d);
  const missingSlice = circularSlice(missing, Number(state.cursors.vercelMissing) || 0, crawlLimit);
  const cappedMissing = missingSlice.entries;

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
  state.cursors.vercelMissing = missingSlice.next;
  const stillMissing = entries.filter((entry) => !entry.d).length;
  console.warn(`Vercel description crawl: crawled ${missingResult.crawled}, failed ${missingResult.failed}, still missing ${stillMissing}`);

  const refreshBudget = Math.max(0, crawlLimit - missingResult.crawled);
  let refreshed = 0;
  let refreshFailed = 0;
  let changed = 0;

  if (refreshBudget > 0) {
    const entriesWithD = entries.filter((entry) => entry.d);
    if (entriesWithD.length > 0) {
      const refreshSlice = circularSlice(entriesWithD, Number(state.cursors.vercelDescriptions) || 0, refreshBudget);

      const refreshResult = await crawlSlice(refreshSlice.entries, (entry, description) => {
        if (description !== entry.d) {
          entry.d = description;
          changed += 1;
        }
      });
      refreshed = refreshResult.crawled;
      refreshFailed = refreshResult.failed;
      state.cursors.vercelDescriptions = refreshSlice.next;
    }
  }

  if (refreshFailed > 0) {
    console.warn(`Vercel description refresh failures: ${refreshFailed}`);
  }
  if (missingResult.failed + refreshFailed > 0) {
    providerFailed("vercel", state, `${missingResult.failed + refreshFailed} description requests failed`);
  } else {
    providerSucceeded("vercel", state);
  }
  console.warn(`Vercel description refresh: refreshed ${refreshed}, changed ${changed}`);
}

async function buildVercelIndex(existingIndex, state) {
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
      await crawlVercelDescriptions(entries, state);
    }
    return entries;
  } catch (error) {
    console.warn(`Vercel skills index refresh failed: ${error.message}`);
    providerFailed("vercel", state, error);
    return null;
  }
}

const outputPath = path.join(root, "catalogue-data.json");
const vercelIndexPath = path.join(root, "catalogue-vercel-index.json");
const existing = await readJsonIfExists(outputPath);
const existingVercelIndex = await readJsonIfExists(vercelIndexPath);
const state = refreshState(await readJsonIfExists(refreshStatePath));
const builtEntries = await build(existing, state);
if (!builtEntries) {
  process.exit();
}
const builtVercelIndexEntries = await buildVercelIndex(existingVercelIndex, state);

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

state.updatedAt = new Date().toISOString();
state.failures = Object.fromEntries(providerFailures);
await fs.writeFile(refreshStatePath, `${JSON.stringify(state, null, 2)}\n`);
