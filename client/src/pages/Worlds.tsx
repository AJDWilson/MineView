import { useEffect, useState } from 'react';
import { useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatBytes, formatTime } from '../lib/format';
import type { WorldInfo } from '../types';

export function WorldsPage() {
  const toast = useToast();
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [levelName, setLevelName] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  async function load() {
    const data = await api<{ worlds: WorldInfo[]; levelName: string | null }>('/api/worlds');
    setWorlds(data.worlds);
    setLevelName(data.levelName);
  }
  useEffect(() => { void load().catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not list worlds', 'err')); }, [toast]);
  return (
    <div className="card table-wrap">
      <p className="help">Configured world: {levelName || 'Unavailable'}. Deleting a world requires the server to be stopped. The folder is archived outside the server directory before it is removed. Restore a world from Backups by choosing that archive and its folder.</p>
      <table>
        <thead><tr><th>World</th><th>Size</th><th>Modified</th><th></th></tr></thead>
        <tbody>
          {worlds.map((world) => (
            <tr key={world.relativePath}>
              <td>{world.name}{world.configured ? ' · configured' : ''}</td>
              <td>{formatBytes(world.size)}</td>
              <td>{formatTime(world.modifiedAt)}</td>
              <td className="row">
                <button className="btn" onClick={() => void api('/api/worlds/backup', { method: 'POST', body: JSON.stringify({ name: world.name }) }).then(() => toast('World backup created')).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Backup failed', 'err'))}>Back up</button>
                <a className="btn" href={`/api/worlds/export?name=${encodeURIComponent(world.name)}`}>Export zip</a>
                <button className="btn danger" onClick={() => setPending(world.name)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {worlds.length === 0 && <p className="empty">No world folders with level.dat were found.</p>}
      {pending && (
        <div className="card" style={{ marginTop: 12 }}>
          <p>Type {pending} to delete it after the archive succeeds.</p>
          <input className="input" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} aria-label="Confirm world name" />
          <button className="btn danger" disabled={confirmName !== pending} onClick={() => void api('/api/worlds/delete', { method: 'POST', body: JSON.stringify({ name: pending, confirmName }) }).then(() => { toast('World archived and removed'); setPending(null); setConfirmName(''); return load(); }).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Delete failed', 'err'))}>Delete world</button>
        </div>
      )}
    </div>
  );
}
