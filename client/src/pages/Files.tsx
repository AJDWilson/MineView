import { useEffect, useState } from 'react';
import { PageHeader, useToast } from '../components/ui';
import { api, ApiError, upload } from '../lib/api';
import { formatBytes, formatTime } from '../lib/format';
import type { FileEntry } from '../types';

export function FilesPage() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [editor, setEditor] = useState<{ path: string; content: string; hash: string; critical: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileEntry[] | null>(null);
  const [folder, setFolder] = useState('');

  async function open(path = '') {
    const data = await api<{ path: string; entries: FileEntry[] }>(`/api/files?path=${encodeURIComponent(path)}`);
    setCurrent(data.path);
    setEntries(data.entries);
  }
  useEffect(() => { void open().catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not open the folder', 'err')); }, [toast]);

  return (
    <>
    <PageHeader title="Files">Everything here is inside the selected server folder.</PageHeader>
    <div className="grid-stats" style={{ gridTemplateColumns: '1.2fr .8fr' }}>
      <div className="card">
        <div className="row">
          <strong>{current || 'Server root'}</strong>
          {current && <button className="btn" onClick={() => void open(current.split(/[\\/]/).slice(0, -1).join('/'))}>Up</button>}
          <button className="btn" onClick={() => void api('/api/files/reveal', { method: 'POST', body: JSON.stringify({ path: current }) })}>Open in Explorer</button>
        </div>
        <form className="row" onSubmit={(event) => { event.preventDefault(); void api<{ results: FileEntry[] }>(`/api/files/search?q=${encodeURIComponent(query)}`).then((data) => setResults(data.results)); }}>
          <input className="input" placeholder="Search file names" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search files" />
          <button className="btn">Search</button>
        </form>
        <table>
          <thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
          <tbody>
            {(results ?? entries).map((entry) => (
              <tr key={entry.path}>
                <td>{entry.critical ? '⚠ ' : ''}{entry.type === 'directory'
                  ? <button className="btn ghost" onClick={() => { setResults(null); void open(entry.path); }}>{entry.name}</button>
                  : <button className="btn ghost" onClick={() => void api<{ path: string; content: string; hash: string; critical: boolean }>(`/api/files/read?path=${encodeURIComponent(entry.path)}`).then(setEditor).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Cannot edit this file', 'err'))}>{entry.name}</button>}
                </td>
                <td>{entry.type === 'directory' ? '—' : formatBytes(entry.size)}</td>
                <td>{formatTime(entry.modifiedAt)}
                  <div className="row">
                    {entry.type === 'file' && <a href={`/api/files/download?path=${encodeURIComponent(entry.path)}`}>Download</a>}
                    <button className="btn" onClick={() => { const next = prompt('New name', entry.name); if (next) void api('/api/files/rename', { method: 'POST', body: JSON.stringify({ from: entry.path, to: next }) }).then(() => open(current)); }}>Rename</button>
                    <button className="btn danger" onClick={() => { if (confirm(`Delete ${entry.name}?`)) void api('/api/files', { method: 'DELETE', body: JSON.stringify({ path: entry.path, confirm: true, confirmCritical: entry.critical && confirm('This is a critical server file. Delete it anyway?') }) }).then(() => open(current)).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Delete failed', 'err')); }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="row" onSubmit={(event) => { event.preventDefault(); void api('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ path: current ? `${current}/${folder}` : folder }) }).then(() => open(current)); }}>
          <input className="input" placeholder="New folder" value={folder} onChange={(event) => setFolder(event.target.value)} aria-label="New folder" />
          <button className="btn">Create folder</button>
          <input type="file" aria-label="Upload file" onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (!chosen) return;
            const form = new FormData();
            form.set('file', chosen);
            form.set('directory', current);
            form.set('replace', 'false');
            void upload('/api/files/upload', form).then(() => open(current)).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Upload failed', 'err'));
          }} />
        </form>
      </div>
      <div className="card">
        {editor ? (
          <form onSubmit={(event) => { event.preventDefault(); void api<{ hash: string }>('/api/files/write', { method: 'PUT', body: JSON.stringify(editor) }).then((saved) => { setEditor({ ...editor, hash: saved.hash }); toast('Saved. A backup of the previous file was kept.'); }).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Save failed', 'err')); }}>
            <strong>{editor.path}</strong>
            {editor.critical && <p style={{ color: 'var(--warn)' }}>This is a critical server file. A backup is stored before each save.</p>}
            <textarea className="textarea" value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} aria-label="File contents" />
            <button className="btn primary" type="submit">Save</button>
          </form>
        ) : <p className="empty">Choose a text file to edit. Binary files can be downloaded but not edited.</p>}
      </div>
    </div>
    </>
  );
}
