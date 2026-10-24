import type { CompatibilityStatus, ServerSoftware } from '../../../shared/types.ts';

const EXACT: Record<ServerSoftware, string[]> = {
  paper: ['paper'],
  purpur: ['purpur'],
  spigot: ['spigot'],
  bukkit: ['bukkit'],
  folia: ['folia'],
  fabric: ['fabric'],
  forge: ['forge'],
  neoforge: ['neoforge'],
  vanilla: [],
  hybrid: [],
  unknown: [],
};

const POSSIBLE: Record<ServerSoftware, string[]> = {
  paper: ['spigot', 'bukkit'],
  purpur: ['paper', 'spigot', 'bukkit'],
  spigot: ['bukkit'],
  bukkit: [],
  folia: ['paper'],
  fabric: ['quilt'],
  forge: [],
  neoforge: ['forge'],
  vanilla: [],
  hybrid: ['paper', 'spigot', 'bukkit', 'fabric', 'forge'],
  unknown: [],
};

export interface ReleaseFacts {
  loaders: string[];
  gameVersions: string[];
}

export interface ServerTarget {
  software: ServerSoftware;
  mcVersion: string | null;
}

export function classifyRelease(target: ServerTarget, release: ReleaseFacts): { status: CompatibilityStatus; reason: string } {
  const platform = platformAxis(target.software, release.loaders);
  const version = versionAxis(target.mcVersion, release.gameVersions);
  return { status: combine(version, platform), reason: reasonFor(target, version, platform, release) };
}

export function chooseRelease<T extends ReleaseFacts & { id: string }>(versions: T[], target: ServerTarget): { release: T; status: CompatibilityStatus; reason: string } | null {
  let best: { release: T; status: CompatibilityStatus; reason: string; rank: number } | null = null;
  for (const release of versions) {
    const judged = classifyRelease(target, release);
    const rank = judged.status === 'compatible' ? 3 : judged.status === 'possible' ? 2 : judged.status === 'unknown' ? 1 : 0;
    if (!best || rank > best.rank) best = { release, ...judged, rank };
  }
  return best ? { release: best.release, status: best.status, reason: best.reason } : null;
}

export function gameVersionsOf(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => /^(?:1\.\d{1,2}(?:\.\d{1,2})?|\d{2}\.\d{1,2}(?:\.\d{1,2})?)$/.test(value));
}

function platformAxis(software: ServerSoftware, loaders: string[]): CompatibilityStatus {
  const normalized = loaders.map((loader) => loader.toLowerCase());
  if (!normalized.length || software === 'unknown') return 'unknown';
  if (EXACT[software].some((loader) => normalized.includes(loader))) return 'compatible';
  if (POSSIBLE[software].some((loader) => normalized.includes(loader))) return 'possible';
  return 'incompatible';
}

function versionAxis(mcVersion: string | null, listed: string[]): CompatibilityStatus {
  const versions = gameVersionsOf(listed);
  if (!mcVersion || !versions.length) return 'unknown';
  const server = mcVersion.trim();
  if (versions.some((version) => version.toLowerCase() === server.toLowerCase())) return 'compatible';
  if (versions.some((version) => relatedVersion(server, version))) return 'possible';
  return 'incompatible';
}

function relatedVersion(server: string, listed: string): boolean {
  const left = server.toLowerCase();
  const right = listed.toLowerCase();
  return left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function combine(version: CompatibilityStatus, platform: CompatibilityStatus): CompatibilityStatus {
  if (version === 'incompatible' || platform === 'incompatible') return 'incompatible';
  if (version === 'compatible' && platform === 'compatible') return 'compatible';
  if (version === 'unknown' && platform === 'unknown') return 'unknown';
  if (version === 'possible' || platform === 'possible') return 'possible';
  return 'unknown';
}

function reasonFor(target: ServerTarget, version: CompatibilityStatus, platform: CompatibilityStatus, release: ReleaseFacts): string {
  const platforms = release.loaders.length ? release.loaders.join(', ') : 'no platform listed';
  const versions = gameVersionsOf(release.gameVersions);
  const versionText = versions.length ? versions.slice(0, 6).join(', ') : 'no Minecraft version listed';
  if (platform === 'incompatible') {
    return `Listed platforms (${platforms}) do not include ${target.software}. A download existing is not treated as compatibility.`;
  }
  if (version === 'incompatible') {
    return `Listed Minecraft versions (${versionText}) do not include ${target.mcVersion}.`;
  }
  if (version === 'compatible' && platform === 'compatible') {
    return `A release lists ${target.software} and Minecraft ${target.mcVersion}.`;
  }
  if (platform === 'possible') {
    return `The release lists ${platforms}, which can sometimes run on ${target.software}, but that platform was not declared.`;
  }
  if (version === 'possible') {
    return `Minecraft versions are related to ${target.mcVersion ?? 'the server'} (${versionText}) but not an exact match.`;
  }
  if (!target.mcVersion || target.software === 'unknown') return 'Server version or software is not known, so compatibility is unknown.';
  return `The repository did not provide enough platform or version data (${platforms}; ${versionText}).`;
}
