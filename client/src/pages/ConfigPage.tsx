import { useEffect, useState } from 'react';
import { PageHeader, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type { ConfigFileInfo, PropertyField } from '../types';

export function ConfigPage() {
  const toast = useToast();
  const [files, setFiles] = useState<ConfigFileInfo[]>([]);
  const [fields, setFields] = useState<PropertyField[]>([]);
  const [hash, setHash] = useState('');
  const [rawPath, setRawPath] = useState('server.properties');
  const [raw, setRaw] = useState('');
  const [rawHash, setRawHash] = useState('');
  const [mode, setMode] = useState<'form' | 'raw'>('form');

  async function load() {
    const list = await api<{ files: ConfigFileInfo[] }>('/api/config');
    setFiles(list.files);
    const form = await api<{ fields: PropertyField[]; hash: string }>('/api/config/properties');
    setFields(form.fields);
    setHash(form.hash);
  }
  useEffect(() => { void load().catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not load configuration', 'err')); }, [toast]);

  async function openRaw(path: string) {
    const file = await api<{ content: string; hash: string }>(`/api/config/file?path=${encodeURIComponent(path)}`);
    setRawPath(path);
    setRaw(file.content);
    setRawHash(file.hash);
    setMode('raw');
  }

  const fileValue = mode === 'form' ? '__form__' : rawPath;

  return (
    <>
      <PageHeader title="Configuration">Edit server.properties as labeled fields, or open another file as text. Each save keeps a backup.</PageHeader>
      <div className="card stack">
        <label className="field">
          <span>File</span>
          <select className="select" aria-label="Configuration file" value={fileValue} onChange={(event) => {
            const next = event.target.value;
            if (next === '__form__') setMode('form');
            else void openRaw(next);
          }}>
            <option value="__form__">server.properties form</option>
            {files.map((file) => <option key={file.path} value={file.path}>{file.name}</option>)}
          </select>
        </label>
        {files.length === 0 && <p className="help">No extra configuration files were found yet. The form still edits server.properties.</p>}
        {mode === 'form' ? (
          <form style={{ display: 'grid', gap: 10 }} onSubmit={(event) => {
            event.preventDefault();
            const values = Object.fromEntries(fields.map((field) => [field.key, field.value]));
            void api('/api/config/properties', { method: 'PUT', body: JSON.stringify({ hash, values }) }).then(() => { toast('Saved. A backup was kept. Restart the server for most of these settings.'); return load(); }).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Save failed', 'err'));
          }}>
            {fields.map((field) => (
              <label key={field.key} className="field">
                <span>{field.label} {field.restartRequired ? '· restart required' : '· can also be changed with a command'}</span>
                {field.type === 'boolean' ? <select className="select" value={field.value} onChange={(event) => setFields(fields.map((item) => item.key === field.key ? { ...item, value: event.target.value } : item))}>{field.value === '' && <option value="">Not set</option>}<option value="true">true</option><option value="false">false</option></select>
                  : field.type === 'select' ? <select className="select" value={field.value} onChange={(event) => setFields(fields.map((item) => item.key === field.key ? { ...item, value: event.target.value } : item))}>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
                    : <input className="input" value={field.value} onChange={(event) => setFields(fields.map((item) => item.key === field.key ? { ...item, value: event.target.value } : item))} />}
                <span>{field.help}</span>
              </label>
            ))}
            <p className="help">Mineview will not set eula=true for you. Open eula.txt and change it yourself if you accept the Minecraft EULA.</p>
            <button className="btn primary">Save server.properties</button>
          </form>
        ) : (
          <form className="stack" onSubmit={(event) => { event.preventDefault(); void api('/api/config/file', { method: 'PUT', body: JSON.stringify({ path: rawPath, content: raw, hash: rawHash }) }).then(() => toast('Saved')).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Save failed', 'err')); }}>
            <strong>{rawPath}</strong>
            <textarea className="textarea" value={raw} onChange={(event) => setRaw(event.target.value)} aria-label="Raw configuration" />
            <div className="row">
              <button className="btn primary">Save</button>
              <button className="btn" type="button" onClick={() => void api('/api/config/revert', { method: 'POST', body: JSON.stringify({ path: rawPath }) }).then(() => openRaw(rawPath)).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'No backup to restore', 'err'))}>Revert to previous</button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
