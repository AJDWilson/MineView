export interface JavaRequirement {
  min: number;
  recommended: number | null;
  known: boolean;
}

export function parseJavaMajor(versionText: string): number | null {
  const quoted = /version "(?:1\.)?(\d+)/.exec(versionText);
  if (quoted) return Number(quoted[1]);
  const loose = /\b(\d+)\.\d+(?:\.\d+)?/.exec(versionText);
  if (!loose) return null;
  const major = Number(loose[1]);
  return Number.isFinite(major) ? major : null;
}

export function javaRequirement(mcVersion: string | null): JavaRequirement {
  if (!mcVersion) return { min: 21, recommended: null, known: false };
  const parts = mcVersion.split('.').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part))) return { min: 21, recommended: null, known: false };
  const [major, minor = 0, patch = 0] = parts;
  if (major === 1) {
    if (minor > 20 || (minor === 20 && patch >= 5)) return { min: 21, recommended: 21, known: true };
    if (minor >= 18) return { min: 17, recommended: 17, known: true };
    if (minor === 17) return { min: 16, recommended: 16, known: true };
    return { min: 8, recommended: 8, known: true };
  }
  return { min: 21, recommended: null, known: false };
}

export function javaWarnings(mcVersion: string | null, javaMajor: number | null): string[] {
  if (javaMajor == null) return ['Java version could not be read. Check that the executable is a working java.exe.'];
  const requirement = javaRequirement(mcVersion);
  const warnings: string[] = [];
  if (!requirement.known) {
    warnings.push(
      mcVersion
        ? `Mineview has no Java compatibility table for Minecraft ${mcVersion}. Detected Java ${javaMajor}. Confirm the server’s required Java before starting.`
        : `Minecraft version was not detected. Detected Java ${javaMajor}.`,
    );
    if (javaMajor < requirement.min) {
      warnings.push(`Java ${javaMajor} is older than Java ${requirement.min}, which current Minecraft servers typically require.`);
    }
    return warnings;
  }
  if (javaMajor < requirement.min) {
    warnings.push(`Java ${javaMajor} is too old for Minecraft ${mcVersion}. Java ${requirement.min} or newer is required.`);
  } else if (requirement.recommended != null && javaMajor > requirement.recommended + 1) {
    warnings.push(
      `Java ${javaMajor} is newer than Java ${requirement.recommended}, which Minecraft ${mcVersion} is usually tested with. The server may still start, but plugins can break.`,
    );
  }
  return warnings;
}
