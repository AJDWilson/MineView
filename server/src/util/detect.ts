import type { ServerSoftware } from '../../../shared/types.ts';

export function versionFromFilename(fileName: string): string | null {
  const match = /(?:^|[^0-9])(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)(?:[^0-9]|$)/.exec(fileName);
  return match?.[1] ?? null;
}

export function versionFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  return versionFromFilename(text);
}

export function versionFromJson(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { id?: string; name?: string; release_target?: string };
    return parsed.id || parsed.name || parsed.release_target || null;
  } catch {
    return null;
  }
}

export function detectFromName(fileName: string): ServerSoftware | null {
  const name = fileName.toLowerCase();
  if (name.includes('purpur')) return 'purpur';
  if (name.includes('folia')) return 'folia';
  if (name.includes('pufferfish') || name.includes('paper')) return 'paper';
  if (name.includes('spigot')) return 'spigot';
  if (name.includes('craftbukkit') || name.includes('bukkit')) return 'bukkit';
  if (name.includes('neoforge')) return 'neoforge';
  if (name.includes('forge') || name.includes('mohist') || name.includes('arclight') || name.includes('magma')) {
    return name.includes('forge') && !name.includes('mohist') && !name.includes('arclight') && !name.includes('magma')
      ? 'forge'
      : 'hybrid';
  }
  if (name.includes('fabric') || name.includes('quilt')) return 'fabric';
  return null;
}

export function detectSoftware(input: {
  fileName: string;
  manifest?: string | null;
  versionJson?: string | null;
}): { software: ServerSoftware; version: string | null } {
  const manifest = input.manifest ?? '';
  const title = /Implementation-Title:\s*(.+)/i.exec(manifest)?.[1]?.trim().toLowerCase() ?? '';
  const mainClass = /Main-Class:\s*(.+)/i.exec(manifest)?.[1]?.trim() ?? '';
  const implementation = /Implementation-Version:\s*(.+)/i.exec(manifest)?.[1]?.trim() ?? '';
  const named = detectFromName(input.fileName) ?? detectFromName(title);
  let software: ServerSoftware = named ?? 'unknown';
  if (software === 'unknown') {
    const blob = `${title} ${mainClass}`.toLowerCase();
    if (blob.includes('purpur')) software = 'purpur';
    else if (blob.includes('paper')) software = 'paper';
    else if (blob.includes('spigot')) software = 'spigot';
    else if (blob.includes('bukkit')) software = 'bukkit';
    else if (blob.includes('neoforge')) software = 'neoforge';
    else if (blob.includes('fabric')) software = 'fabric';
    else if (blob.includes('forge')) software = 'forge';
    else if (mainClass.includes('net.minecraft') || input.fileName.toLowerCase() === 'server.jar') software = 'vanilla';
  }
  const version = versionFromJson(input.versionJson) ?? versionFromText(implementation) ?? versionFromFilename(input.fileName);
  return { software, version };
}

export function pluginContainerFor(software: ServerSoftware): 'plugins' | 'mods' | 'none' {
  if (software === 'fabric' || software === 'forge' || software === 'neoforge') return 'mods';
  if (software === 'vanilla' || software === 'unknown') return software === 'vanilla' ? 'none' : 'plugins';
  return 'plugins';
}

export function serverBuildFromText(text: string): { software: ServerSoftware | null; mcVersion: string | null; build: string | null } {
  const running = /This server is running ([A-Za-z]+) version (\S+)(?: \(MC: ([^)]+)\))?/i.exec(text);
  if (running) {
    const software = detectFromName(running[1] ?? '') ?? null;
    return { software, mcVersion: running[3]?.trim() || versionFromText(running[2]) , build: running[2]?.trim() ?? null };
  }
  const vanilla = /Starting minecraft server version (\d+\.\d+(?:\.\d+)?)/i.exec(text);
  if (vanilla) return { software: 'vanilla', mcVersion: vanilla[1] ?? null, build: vanilla[1] ?? null };
  return { software: null, mcVersion: null, build: null };
}

export function bukkitFamily(software: ServerSoftware | null): boolean {
  return software === 'paper' || software === 'purpur' || software === 'spigot' || software === 'bukkit' || software === 'folia' || software === 'hybrid';
}
