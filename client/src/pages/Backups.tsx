import { useEffect, useState } from 'react';
import { PageHeader, useToast } from '../components/ui';
import { api, ApiError, upload } from '../lib/api';
import { formatBytes, formatTime } from '../lib/format';
import type { BackupInfo } from '../types';

export function BackupsPage() {
  const toast = useToast();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [directory, setDirectory] = useState('');
  const [kind, setKind] = useState('full');
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [components, setComponents] = useState<string[]>([]);
  async function load() {
    const data = await api<{ backups: BackupInfo[]; directory: string }>('/api/backups');
    setBackups(data.backups);
    setDirectory(data.directory);
  }
  useEffect(() => { void load().catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not list backups', 'err')); }, [toast]);
  return (
    <>
    <PageHeader title="Backups">Archives are stored outside the server directory ({directory || 'Unavailable'}).</PageHeader>
    <div className="card stack">
      <p className="help">A running server is asked to save-all flush when Mineview owns the console. Otherwise the archive may be inconsistent.</p>
      <div className="row">
        <select className="select" style={{ maxWidth: 180 }} value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Backup contents">
          <option value="full">Full</option><option value="worlds">Worlds</option><option value="plugins">Plugins</option><option value="config">Configuration</option>
        </select>
        <button className="btn primary" onClick={() => void api('/api/backups', { method: 'POST', body: JSON.stringify({ kind }) }).then(() => { toast('Backup finished'); return load(); }).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Backup failed', 'err'))}>Create backup</button>
        <button className="btn" onClick={() => void api('/api/backups/scan', { method: 'POST', body: '{}' }).then(() => load())}>Scan backup folder</button>
        <input type="file" accept=".zip" aria-label="Import backup" onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const form = new FormData();
          form.set('file', file);
          void upload('/api/backups/import', form).then(() => load()).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Import failed', 'err'));
        }} />
      </div>
      <table>
        <thead><tr><th>When</th><th>Kind</th><th>Size</th><th>Status</th><th>Contents</th><th></th></tr></thead>
        <tbody>
          {backups.map((backup) => (
            <tr key={backup.id}>
              <td>{formatTime(backup.createdAt)}{backup.label ? ` · ${backup.label}` : ''}</td>
              <td>{backup.kind}</td>
              <td>{formatBytes(backup.size)}</td>
              <td>{backup.status}{backup.consistent ? '' : ' · may be inconsistent'}</td>
              <td>{backup.contents.join(', ') || 'Unavailable'}</td>
              <td className="row">
                <a className="btn" href={`/api/backups/${backup.id}/download`}>Download</a>
                <button className="btn" onClick={() => { setRestoreId(backup.id); setComponents([]); }}>Restore</button>
                <button className="btn danger" onClick={() => { if (confirm('Delete this backup archive?')) void api(`/api/backups/${backup.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }).then(load); }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {backups.length === 0 && <p className="empty">No backups yet.</p>}
      {restoreId && (
        <form onSubmit={(event) => {
          event.preventDefault();
          const chosen = backups.find((item) => item.id === restoreId);
          if (!chosen || !confirm('Restore this backup? The server must be stopped. A full safety backup is created first, and nothing is restored if that fails.')) return;
          void api(`/api/backups/${restoreId}/restore`, { method: 'POST', body: JSON.stringify({ confirm: true, components }) }).then(() => { toast('Restore finished'); setRestoreId(null); }).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Restore failed', 'err'));
        }}>
          <strong>Restore {restoreId}</strong>
          <p className="help">Leave every box clear to restore the whole archive. Select folders to restore only those top-level items, such as one world.</p>
          {(backups.find((item) => item.id === restoreId)?.contents ?? []).map((item) => (
            <label key={item} style={{ display: 'block' }}>
              <input type="checkbox" checked={components.includes(item)} onChange={(event) => setComponents(event.target.checked ? [...components, item] : components.filter((name) => name !== item))} /> {item}
            </label>
          ))}
          <button className="btn primary">Restore selected</button>
          <button className="btn" type="button" onClick={() => setRestoreId(null)}>Cancel</button>
        </form>
      )}
    </div>
    </>
  );
}
