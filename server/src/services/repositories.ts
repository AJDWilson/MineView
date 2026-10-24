import type { PluginProjectDetail, PluginSearchHit, PluginSource, PluginVersionChoice } from '../../../shared/types.ts';
import { HttpError } from '../util/errors.ts';
import { fetchAllowlisted } from '../util/net.ts';
import { classifyRelease, gameVersionsOf, type ServerTarget } from './compatibility.ts';

export interface SearchQuery {
  source: PluginSource;
  q: string;
  version?: string;
  loader?: string;
  category?: string;
  sort: 'relevance' | 'downloads' | 'updated';
  offset: number;
  limit: number;
  projectType: 'plugin' | 'mod';
  strict?: boolean;
}

const cache = new Map<string, { at: number; value: unknown }>();

export function modrinthSearchUrl(query: SearchQuery): string {
  const facets: string[][] = [[`project_type:${query.projectType}`]];
  if (query.loader) facets.push([`categories:${query.loader}`]);
  if (query.version) facets.push([`versions:${query.version}`]);
  if (query.category) facets.push([`categories:${query.category}`]);
  const params = new URLSearchParams({
    query: query.q,
    limit: String(query.limit),
    offset: String(query.offset),
    index: query.sort === 'downloads' ? 'downloads' : query.sort === 'updated' ? 'updated' : 'relevance',
    facets: JSON.stringify(facets),
  });
  return `https://api.modrinth.com/v2/search?${params}`;
}

export function hangarSearchUrl(query: SearchQuery): string {
  const params = new URLSearchParams({ q: query.q, limit: String(query.limit), offset: String(query.offset) });
  if (query.sort === 'downloads') params.set('sort', '-downloads');
  if (query.sort === 'updated') params.set('sort', '-updated');
  return `https://hangar.papermc.io/api/v1/projects?${params}`;
}

export function mapModrinthHit(hit: ModrinthHit): PluginSearchHit {
  return {
    source: 'modrinth',
    projectId: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description ?? '',
    author: hit.author ?? 'Unknown',
    downloads: hit.downloads ?? null,
    updatedAt: hit.date_modified ?? null,
    categories: hit.categories ?? [],
    gameVersions: hit.versions ?? [],
    iconUrl: safeIcon(hit.icon_url),
    projectUrl: `https://modrinth.com/${hit.project_type === 'mod' ? 'mod' : 'plugin'}/${hit.slug}`,
    ...unclassified(hit.categories ?? []),
  };
}

export function mapHangarHit(hit: HangarHit): PluginSearchHit {
  return {
    source: 'hangar',
    projectId: `${hit.namespace.owner}/${hit.namespace.slug}`,
    slug: hit.namespace.slug,
    title: hit.name,
    description: hit.description ?? '',
    author: hit.namespace.owner,
    downloads: hit.stats?.downloads ?? null,
    updatedAt: hit.lastUpdated ?? null,
    categories: hit.category ? [hit.category] : [],
    gameVersions: [],
    iconUrl: safeIcon(hit.avatarUrl),
    projectUrl: `https://hangar.papermc.io/${hit.namespace.owner}/${hit.namespace.slug}`,
    ...unclassified([]),
  };
}

export async function searchPlugins(query: SearchQuery): Promise<{ hits: PluginSearchHit[]; total: number | null }> {
  const key = JSON.stringify(query);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.value as { hits: PluginSearchHit[]; total: number | null };
  try {
    if (query.source === 'modrinth') {
      const response = await fetchAllowlisted(modrinthSearchUrl(query), { timeoutMs: 20_000 });
      if (response.status === 429) throw new HttpError(429, 'Modrinth rate limit reached. Try again shortly.', 'RATE_LIMIT');
      if (!response.ok) throw new HttpError(502, `Modrinth search failed (${response.status})`, 'UPSTREAM');
      const body = await response.json() as { hits?: ModrinthHit[]; total_hits?: number };
      const value = { hits: (body.hits ?? []).map(mapModrinthHit), total: body.total_hits ?? null };
      cache.set(key, { at: Date.now(), value });
      return value;
    }
    if (query.source === 'hangar') {
      const response = await fetchAllowlisted(hangarSearchUrl(query), { timeoutMs: 20_000 });
      if (response.status === 429) throw new HttpError(429, 'Hangar rate limit reached. Try again shortly.', 'RATE_LIMIT');
      if (!response.ok) throw new HttpError(502, `Hangar search failed (${response.status})`, 'UPSTREAM');
      const body = await response.json() as { result?: HangarHit[]; pagination?: { count?: number } };
      const value = { hits: (body.result ?? []).map(mapHangarHit), total: body.pagination?.count ?? null };
      cache.set(key, { at: Date.now(), value });
      return value;
    }
    const response = await fetchAllowlisted(spigetSearchUrl(query), { timeoutMs: 20_000 });
    if (response.status === 429) throw new HttpError(429, 'Spiget rate limit reached. Try again shortly.', 'RATE_LIMIT');
    if (!response.ok) throw new HttpError(502, `Spiget search failed (${response.status})`, 'UPSTREAM');
    const body = await response.json() as SpigetResource[];
    const totalHeader = Number(response.headers.get('x-total-count'));
    const value = { hits: body.map(mapSpigetHit), total: Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'The plugin repository could not be reached', 'UPSTREAM');
  }
}

export async function projectDetail(source: PluginSource, projectId: string, loader?: string, target?: ServerTarget): Promise<PluginProjectDetail> {
  const detail = source === 'modrinth'
    ? await modrinthProject(projectId, loader)
    : source === 'spiget'
      ? await spigetProject(projectId)
      : await hangarProject(projectId);
  if (!target) return detail;
  return { ...detail, versions: detail.versions.map((version) => annotateVersion(version, target)) };
}

export function mapModrinthVersion(version: ModrinthVersion): PluginVersionChoice {
  const file = version.files?.find((item) => item.primary) ?? version.files?.find((item) => item.filename?.endsWith('.jar'));
  return {
    id: version.id,
    name: version.name,
    versionNumber: version.version_number,
    date: version.date_published ?? null,
    gameVersions: version.game_versions ?? [],
    loaders: version.loaders ?? [],
    downloads: version.downloads ?? null,
    filename: file?.filename ?? null,
    size: file?.size ?? null,
    sha1: file?.hashes?.sha1 ?? null,
    changelog: version.changelog ?? null,
    dependencies: (version.dependencies ?? []).filter((item) => item.project_id).map((item) => ({
      projectId: item.project_id!,
      title: null,
      required: item.dependency_type === 'required',
    })),
    compatibility: 'unknown',
    compatibilityReason: 'Not checked against a server yet.',
  };
}

async function modrinthProject(projectId: string, loader?: string): Promise<PluginProjectDetail> {
  const projectRes = await fetchAllowlisted(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`, { timeoutMs: 20_000 });
  if (!projectRes.ok) throw new HttpError(502, `Modrinth project lookup failed (${projectRes.status})`, 'UPSTREAM');
  const project = await projectRes.json() as ModrinthProject;
  const params = new URLSearchParams();
  if (loader) params.set('loaders', JSON.stringify([loader]));
  const versionRes = await fetchAllowlisted(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${params}`, { timeoutMs: 20_000 });
  if (!versionRes.ok) throw new HttpError(502, `Modrinth versions lookup failed (${versionRes.status})`, 'UPSTREAM');
  const versions = await versionRes.json() as ModrinthVersion[];
  return {
    source: 'modrinth',
    projectId: project.id,
    title: project.title,
    description: project.description ?? '',
    body: (project.body ?? '').slice(0, 8000),
    author: project.author ?? project.team ?? 'Unknown',
    downloads: project.downloads ?? null,
    categories: project.categories ?? [],
    sourceUrl: httpsOrNull(project.source_url),
    issuesUrl: httpsOrNull(project.issues_url),
    projectUrl: `https://modrinth.com/plugin/${project.slug}`,
    versions: versions.slice(0, 30).map(mapModrinthVersion),
  };
}

async function hangarProject(projectId: string): Promise<PluginProjectDetail> {
  const [owner, slug] = projectId.split('/');
  if (!owner || !slug) throw new HttpError(400, 'Hangar project id must be owner/slug', 'BAD_ID');
  const projectRes = await fetchAllowlisted(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`, { timeoutMs: 20_000 });
  if (!projectRes.ok) throw new HttpError(502, `Hangar project lookup failed (${projectRes.status})`, 'UPSTREAM');
  const project = await projectRes.json() as HangarHit & { description?: string };
  const versionRes = await fetchAllowlisted(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions?limit=25&offset=0`, { timeoutMs: 20_000 });
  if (!versionRes.ok) throw new HttpError(502, `Hangar versions lookup failed (${versionRes.status})`, 'UPSTREAM');
  const body = await versionRes.json() as { result?: HangarVersion[] };
  return {
    source: 'hangar',
    projectId,
    title: project.name,
    description: project.description ?? '',
    body: project.description ?? '',
    author: owner,
    downloads: project.stats?.downloads ?? null,
    categories: project.category ? [project.category] : [],
    sourceUrl: null,
    issuesUrl: null,
    projectUrl: `https://hangar.papermc.io/${owner}/${slug}`,
    versions: (body.result ?? []).map(mapHangarVersion),
  };
}

export function mapHangarVersion(version: HangarVersion): PluginVersionChoice {
  const paper = version.downloads?.PAPER ?? version.downloads?.WATERFALL ?? Object.values(version.downloads ?? {})[0];
  const platforms = version.platformDependencies ? Object.values(version.platformDependencies).flat() : [];
  return {
    id: String(version.id),
    name: version.name,
    versionNumber: version.name,
    date: version.createdAt ?? null,
    gameVersions: gameVersionsOf(platforms),
    loaders: Object.keys(version.downloads ?? {}).map((loader) => loader.toLowerCase()),
    downloads: version.stats?.totalDownloads ?? null,
    filename: paper?.fileInfo?.name ?? null,
    size: paper?.fileInfo?.sizeBytes ?? null,
    sha1: null,
    changelog: version.description ?? null,
    dependencies: [],
    compatibility: 'unknown',
    compatibilityReason: 'Not checked against a server yet.',
  };
}

export async function resolveDownload(source: PluginSource, projectId: string, versionId: string): Promise<{ url: string; filename: string; size: number | null; sha1: string | null; gameVersions: string[]; loaders: string[]; dependencies: { projectId: string; required: boolean }[] }> {
  if (source === 'modrinth') {
    const response = await fetchAllowlisted(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`, { timeoutMs: 20_000 });
    if (!response.ok) throw new HttpError(502, 'Modrinth version lookup failed', 'UPSTREAM');
    const version = await response.json() as ModrinthVersion;
    const file = version.files?.find((item) => item.primary && item.filename.endsWith('.jar')) ?? version.files?.find((item) => item.filename.endsWith('.jar'));
    if (!file) throw new HttpError(400, 'That Modrinth version has no JAR file', 'NO_JAR');
    return {
      url: file.url,
      filename: file.filename,
      size: file.size ?? null,
      gameVersions: version.game_versions ?? [],
      loaders: version.loaders ?? [],
      sha1: file.hashes?.sha1 ?? null,
      dependencies: (version.dependencies ?? []).filter((item) => item.project_id).map((item) => ({ projectId: item.project_id!, required: item.dependency_type === 'required' })),
    };
  }
  if (source === 'spiget') return resolveSpigetDownload(projectId, versionId);
  const detail = await hangarProject(projectId);
  const version = detail.versions.find((item) => item.id === versionId);
  if (!version?.filename) throw new HttpError(400, 'That Hangar version has no downloadable JAR', 'NO_JAR');
  const [owner, slug] = projectId.split('/');
  const response = await fetchAllowlisted(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(owner!)}/${encodeURIComponent(slug!)}/versions?limit=25`, { timeoutMs: 20_000 });
  const body = await response.json() as { result?: HangarVersion[] };
  const raw = (body.result ?? []).find((item) => String(item.id) === versionId);
  const paper = raw?.downloads?.PAPER ?? Object.values(raw?.downloads ?? {})[0];
  if (!paper?.downloadUrl) throw new HttpError(400, 'Hangar did not provide a download URL', 'NO_JAR');
  return { url: paper.downloadUrl, filename: paper.fileInfo?.name ?? version.filename, size: paper.fileInfo?.sizeBytes ?? null, sha1: null, gameVersions: version.gameVersions, loaders: version.loaders, dependencies: [] };
}

export function spigetSearchUrl(query: SearchQuery): string {
  const page = Math.floor(query.offset / query.limit) + 1;
  const params = new URLSearchParams({ size: String(query.limit), page: String(page) });
  if (query.sort === 'downloads') params.set('sort', '-downloads');
  if (query.sort === 'updated') params.set('sort', '-updateDate');
  return `https://api.spiget.org/v2/search/resources/${encodeURIComponent(query.q || 'plugin')}?${params}`;
}

function mapSpigetHit(resource: SpigetResource): PluginSearchHit {
  const tested = resource.testedVersions ?? [];
  return {
    source: 'spiget',
    projectId: String(resource.id),
    slug: String(resource.id),
    title: resource.name,
    description: resource.tag ?? '',
    author: resource.author?.name ?? 'Unknown',
    downloads: resource.downloads ?? null,
    updatedAt: resource.updateDate ? new Date(resource.updateDate * 1000).toISOString() : null,
    categories: resource.category?.name ? [resource.category.name] : [],
    gameVersions: tested,
    iconUrl: spigetIcon(resource.icon?.url),
    projectUrl: `https://www.spigotmc.org/resources/${resource.id}/`,
    rating: resource.rating?.average ?? null,
    loaders: ['spigot'],
    compatibility: 'unknown',
    compatibilityReason: 'Release data has not been checked yet.',
    latestVersion: null,
    latestVersionId: resource.version?.id ? String(resource.version.id) : null,
    dependencies: [],
    installable: false,
    blockedReason: resource.premium || resource.external ? 'This Spigot resource is premium or hosted externally. Mineview will not download it.' : null,
  };
}

async function spigetProject(projectId: string): Promise<PluginProjectDetail> {
  const id = spigetId(projectId);
  const projectRes = await fetchAllowlisted(`https://api.spiget.org/v2/resources/${id}`, { timeoutMs: 20_000 });
  if (!projectRes.ok) throw new HttpError(502, `Spiget project lookup failed (${projectRes.status})`, 'UPSTREAM');
  const project = await projectRes.json() as SpigetResource;
  const versionRes = await fetchAllowlisted(`https://api.spiget.org/v2/resources/${id}/versions?size=20&sort=-releaseDate`, { timeoutMs: 20_000 });
  if (!versionRes.ok) throw new HttpError(502, `Spiget versions lookup failed (${versionRes.status})`, 'UPSTREAM');
  const versions = await versionRes.json() as SpigetVersion[];
  const tested = project.testedVersions ?? [];
  return {
    source: 'spiget',
    projectId: String(project.id),
    title: project.name,
    description: project.tag ?? '',
    body: (project.description ?? project.tag ?? '').slice(0, 8000),
    author: project.author?.name ?? 'Unknown',
    downloads: project.downloads ?? null,
    categories: project.category?.name ? [project.category.name] : [],
    sourceUrl: httpsOrNull(project.sourceCodeLink),
    issuesUrl: null,
    projectUrl: `https://www.spigotmc.org/resources/${project.id}/`,
    versions: versions.map((version) => ({
      id: String(version.id),
      name: version.name,
      versionNumber: version.name,
      date: version.releaseDate ? new Date(version.releaseDate * 1000).toISOString() : null,
      gameVersions: tested,
      loaders: ['spigot'],
      downloads: version.downloads ?? null,
      filename: `${project.name.replace(/[^\w.-]+/g, '_')}.jar`,
      size: null,
      sha1: null,
      changelog: null,
      dependencies: [],
      compatibility: 'unknown' as const,
      compatibilityReason: 'Spiget publishes tested Minecraft versions on the resource, not on each release.',
    })),
  };
}

async function resolveSpigetDownload(projectId: string, versionId: string): Promise<{ url: string; filename: string; size: number | null; sha1: string | null; gameVersions: string[]; loaders: string[]; dependencies: { projectId: string; required: boolean }[] }> {
  const id = spigetId(projectId);
  const projectRes = await fetchAllowlisted(`https://api.spiget.org/v2/resources/${id}`, { timeoutMs: 20_000 });
  if (!projectRes.ok) throw new HttpError(502, 'Spiget resource lookup failed', 'UPSTREAM');
  const project = await projectRes.json() as SpigetResource;
  if (project.premium || project.external) {
    throw new HttpError(400, 'This Spigot resource is premium or hosted externally. Open the project page instead of downloading it here.', 'EXTERNAL');
  }
  const versionRes = await fetchAllowlisted(`https://api.spiget.org/v2/resources/${id}/versions?size=1&sort=-releaseDate`, { timeoutMs: 20_000 });
  if (!versionRes.ok) throw new HttpError(502, 'Spiget version lookup failed', 'UPSTREAM');
  const newest = ((await versionRes.json()) as SpigetVersion[])[0];
  if (!newest || String(newest.id) !== versionId) {
    throw new HttpError(400, 'Spiget only provides a direct file for the newest free release. Older versions stay on the project page.', 'NO_DIRECT_FILE');
  }
  return {
    url: `https://api.spiget.org/v2/resources/${id}/download`,
    filename: `${project.name.replace(/[^\w.-]+/g, '_')}.jar`,
    size: null,
    sha1: null,
    gameVersions: project.testedVersions ?? [],
    loaders: ['spigot'],
    dependencies: [],
  };
}

function annotateVersion(version: PluginVersionChoice, target: ServerTarget): PluginVersionChoice {
  const judged = classifyRelease(target, version);
  return { ...version, compatibility: judged.status, compatibilityReason: judged.reason };
}

function unclassified(loaders: string[]): Pick<PluginSearchHit, 'rating' | 'loaders' | 'compatibility' | 'compatibilityReason' | 'latestVersion' | 'latestVersionId' | 'dependencies' | 'installable' | 'blockedReason'> {
  const known = new Set(['paper', 'purpur', 'spigot', 'bukkit', 'folia', 'fabric', 'forge', 'neoforge', 'quilt']);
  return {
    rating: null,
    loaders: loaders.map((loader) => loader.toLowerCase()).filter((loader) => known.has(loader)),
    compatibility: 'unknown',
    compatibilityReason: 'Release data has not been checked yet.',
    latestVersion: null,
    latestVersionId: null,
    dependencies: [],
    installable: false,
    blockedReason: null,
  };
}

function spigetId(projectId: string): string {
  if (!/^\d+$/.test(projectId)) throw new HttpError(400, 'Spiget resource id must be numeric', 'BAD_ID');
  return projectId;
}

function spigetIcon(url: string | null | undefined): string | null {
  if (!url || url.startsWith('data:')) return null;
  if (url.startsWith('https://')) return safeIcon(url);
  if (url.startsWith('http://')) return null;
  return safeIcon(`https://www.spigotmc.org/${url.replace(/^\//, '')}`);
}

function safeIcon(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function httpsOrNull(url: string | null | undefined): string | null {
  return safeIcon(url);
}

interface ModrinthHit {
  project_id: string;
  project_type?: string;
  slug: string;
  title: string;
  description?: string;
  author?: string;
  categories?: string[];
  versions?: string[];
  downloads?: number;
  icon_url?: string | null;
  date_modified?: string;
}

interface ModrinthProject extends ModrinthHit {
  id: string;
  body?: string;
  source_url?: string | null;
  issues_url?: string | null;
  team?: string;
}

interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  changelog?: string;
  date_published?: string;
  downloads?: number;
  game_versions?: string[];
  loaders?: string[];
  files?: { url: string; filename: string; primary?: boolean; size?: number; hashes?: { sha1?: string } }[];
  dependencies?: { project_id?: string | null; dependency_type?: string }[];
}

interface HangarHit {
  name: string;
  namespace: { owner: string; slug: string };
  description?: string;
  stats?: { downloads?: number };
  category?: string;
  lastUpdated?: string;
  avatarUrl?: string | null;
}

interface HangarVersion {
  id: number | string;
  name: string;
  createdAt?: string;
  description?: string;
  stats?: { totalDownloads?: number };
  downloads?: Record<string, { downloadUrl?: string; fileInfo?: { name?: string; sizeBytes?: number } }>;
  platformDependencies?: Record<string, string[]>;
}

interface SpigetResource {
  id: number;
  name: string;
  tag?: string;
  description?: string;
  downloads?: number;
  updateDate?: number;
  premium?: boolean;
  external?: boolean;
  testedVersions?: string[];
  sourceCodeLink?: string | null;
  author?: { name?: string };
  category?: { name?: string };
  rating?: { average?: number };
  icon?: { url?: string };
  version?: { id?: number };
}

interface SpigetVersion {
  id: number;
  name: string;
  downloads?: number;
  releaseDate?: number;
}
