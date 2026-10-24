export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Unavailable';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remain}s`;
  return `${remain}s`;
}

export function formatTime(value: number | string | null | undefined): string {
  if (value == null || value === '') return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return date.toLocaleString();
}

export function show(value: string | number | null | undefined): string {
  if (value == null || value === '') return 'Unavailable';
  return String(value);
}
