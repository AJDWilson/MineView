import fs from 'node:fs';
import path from 'node:path';
import type { MarketplaceTarget, PluginSearchHit, Profile, ServerSoftware } from '../../../shared/types.ts';
import { serverBuildFromText } from '../util/detect.ts';
import { chooseRelease, classifyRelease, type ServerTarget } from './compatibility.ts';
import { inspectServer } from './discovery.ts';
import { projectDetail, searchPlugins, type SearchQuery } from './repositories.ts';

const SOURCES = ['modrinth', 'hangar', 'spiget'] as const;
const SOFTWARE: ServerSoftware[] = ['paper', 'purpur', 'spigot', 'bukkit', 'folia', 'fabric', 'forge', 'neoforge', 'vanilla', 'hybrid', 'unknown'];
const detectedCache = new Map<string, { at: number; value: MarketplaceTarget }>();

export function isRepositorySource(value: string): value is SearchQuery['source'] {
  return (SOURCES as readonly string[]).includes(value);
}

export function isSoftware(value: string): value is ServerSoftware {
  return (SOFTWARE as string[]).includes(value);
}

export async function marketplaceTarget(profile: Profile): Promise<MarketplaceTarget> {
  const cached = detectedCache.get(profile.directory);
  if (cached && Date.now() - cached.at < 20_000) return { ...cached.value, software: profile.software, mcVersion: profile.mcVersion, pluginContainer: profile.pluginContainer };
  const inspected = await inspectServer(profile.directory).catch(() => null);
  const log = await fs.promises.readFile(path.join(profile.directory, 'logs', 'latest.log'), 'utf8').catch(() => '');
  const fromLog = serverBuildFromText(log.slice(-120_000));
  const value: MarketplaceTarget = {
    software: profile.software,
    mcVersion: profile.mcVersion,
    detectedSoftware: fromLog.software ?? inspected?.suggested.software ?? 'unknown',
    detectedVersion: fromLog.mcVersion ?? inspected?.suggested.version ?? null,
    build: fromLog.build,
    pluginContainer: profile.pluginContainer,
  };
  detectedCache.set(profile.directory, { at: Date.now(), value });
  return value;
}

export async function searchCatalogue(profile: Profile, query: SearchQuery, target: ServerTarget): Promise<{ hits: PluginSearchHit[]; total: number | null; target: MarketplaceTarget }> {
  const info = await marketplaceTarget(profile);
  const found = await searchPlugins({
    ...query,
    version: query.strict ? query.version : undefined,
    loader: query.strict ? query.loader : undefined,
  });
  const hits = await pool(found.hits, 3, (hit) => annotate(hit, target));
  return { hits, total: found.total, target: { ...info, software: target.software, mcVersion: target.mcVersion } };
}

async function annotate(hit: PluginSearchHit, target: ServerTarget): Promise<PluginSearchHit> {
  if (hit.blockedReason) {
    return { ...hit, compatibility: 'unknown', compatibilityReason: hit.blockedReason, installable: false };
  }
  if (hit.source === 'spiget') {
    const judged = classifyRelease(target, { loaders: hit.loaders, gameVersions: hit.gameVersions });
    return {
      ...hit,
      compatibility: judged.status,
      compatibilityReason: `${judged.reason} Spigot publishes tested Minecraft versions on the resource, not on each file.`,
      installable: Boolean(hit.latestVersionId) && (judged.status === 'compatible' || judged.status === 'possible'),
    };
  }
  try {
    const detail = await Promise.race([
      projectDetail(hit.source, hit.projectId, undefined, target),
      timeout<null>(8_000),
    ]);
    if (!detail) {
      return { ...hit, compatibility: 'unknown', compatibilityReason: 'The repository did not return release data in time.', installable: false };
    }
    const chosen = chooseRelease(detail.versions, target);
    if (!chosen) {
      return { ...hit, compatibility: 'unknown', compatibilityReason: 'The repository returned no releases.', installable: false };
    }
    return {
      ...hit,
      author: detail.author || hit.author,
      loaders: chosen.release.loaders,
      gameVersions: chosen.release.gameVersions.length ? chosen.release.gameVersions : hit.gameVersions,
      rating: hit.rating,
      compatibility: chosen.status,
      compatibilityReason: chosen.reason,
      latestVersion: chosen.release.versionNumber,
      latestVersionId: chosen.release.id,
      dependencies: chosen.release.dependencies,
      installable: chosen.status === 'compatible' || chosen.status === 'possible',
      blockedReason: null,
    };
  } catch {
    return { ...hit, compatibility: 'unknown', compatibilityReason: 'The repository did not return release data for this project.', installable: false };
  }
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function timeout<T>(ms: number): Promise<T | null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}
