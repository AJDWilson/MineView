import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { InspectResult, JavaCandidate, JavaCheck, MeResponse } from '../types';

export function Setup({ me, onDone }: { me: MeResponse; onDone: (me: MeResponse) => void }) {
  const navigate = useNavigate();
  const [directory, setDirectory] = useState('');
  const [scan, setScan] = useState<{ directory: string; marker: string }[]>([]);
  const [info, setInfo] = useState<InspectResult | null>(null);
  const [java, setJava] = useState<JavaCandidate[]>([]);
  const [check, setCheck] = useState<JavaCheck | null>(null);
  const [name, setName] = useState('Minecraft');
  const [jar, setJar] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [minMemory, setMinMemory] = useState('1G');
  const [maxMemory, setMaxMemory] = useState('2G');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function inspect(target: string) {
    setBusy('Inspecting');
    setError('');
    try {
      const result = await api<InspectResult>('/api/discovery/inspect', { method: 'POST', body: JSON.stringify({ directory: target }) });
      setInfo(result);
      setDirectory(result.directory);
      setJar(result.suggested.jar ?? '');
      const found = await api<{ candidates: JavaCandidate[] }>('/api/java');
      setJava(found.candidates);
      if (!javaPath && found.candidates[0]) setJavaPath(found.candidates[0].path);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not inspect that folder');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="content" style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="card" style={{ display: 'grid', gap: 14 }}>
        <div>
          <h1 style={{ margin: '0 0 6px' }}>Set up your server</h1>
          <p className="help">Mineview only reads the folder until you explicitly start the server or install a plugin. It will not download or replace an existing server.</p>
        </div>
        <div className="row">
          <button className="btn" disabled={Boolean(busy)} onClick={() => void api<{ results: { directory: string; marker: string }[] }>('/api/discovery/scan', { method: 'POST', body: '{}' }).then((result) => setScan(result.results)).catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Scan failed'))}>Scan common folders</button>
          <button className="btn" disabled={Boolean(busy)} onClick={() => void api<{ path: string | null }>('/api/discovery/browse', { method: 'POST', body: '{}' }).then((result) => { if (result.path) void inspect(result.path); })}>Browse…</button>
        </div>
        <p className="help">If the folder picker is hidden, check the taskbar. You can also type a path.</p>
        <form className="row" onSubmit={(event) => { event.preventDefault(); void inspect(directory); }}>
          <input className="input" style={{ flex: 1 }} placeholder="C:\Servers\my-server" value={directory} onChange={(event) => setDirectory(event.target.value)} aria-label="Server directory" />
          <button className="btn primary" disabled={!directory || Boolean(busy)}>Inspect</button>
        </form>
        {scan.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Found</th><th>Marker</th><th></th></tr></thead>
              <tbody>
                {scan.map((hit) => <tr key={hit.directory}><td>{hit.directory}</td><td>{hit.marker}</td><td><button className="btn" onClick={() => void inspect(hit.directory)}>Use</button></td></tr>)}
              </tbody>
            </table>
          </div>
        )}
        {info && (
          <>
            {!info.valid && <p style={{ color: 'var(--danger)' }}>{info.errors.join(' ')}</p>}
            {info.warnings.map((warning) => <p key={warning} style={{ color: 'var(--warn)' }}>{warning}</p>)}
            <p>Detected {info.suggested.software} {info.suggested.version ?? '(version unavailable)'} · {info.plugins.length} plugins · {info.worlds.length} worlds</p>
            <label className="field"><span>Profile name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="field"><span>Server JAR</span>
              <select className="select" value={jar} onChange={(event) => setJar(event.target.value)}>
                {info.jars.map((item) => <option key={item.relativePath} value={item.relativePath}>{item.name} · {item.software} · {item.version ?? 'version unavailable'}</option>)}
              </select>
            </label>
            <label className="field"><span>Java executable</span>
              <input className="input" value={javaPath} onChange={(event) => setJavaPath(event.target.value)} placeholder="C:\Program Files\Java\bin\java.exe" />
            </label>
            {java.length > 0 && <div className="row">{java.map((item) => <button type="button" key={item.path} className="btn" onClick={() => setJavaPath(item.path)}>{item.version ?? item.path}</button>)}</div>}
            <div className="row">
              <label className="field"><span>Minimum memory</span><input className="input" value={minMemory} onChange={(event) => setMinMemory(event.target.value)} /></label>
              <label className="field"><span>Maximum memory</span><input className="input" value={maxMemory} onChange={(event) => setMaxMemory(event.target.value)} /></label>
            </div>
            <div className="row">
              <button className="btn" disabled={!javaPath} onClick={() => void api<JavaCheck>('/api/java/check', { method: 'POST', body: JSON.stringify({ executable: javaPath, minecraftVersion: info.suggested.version }) }).then(setCheck).catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Java check failed'))}>Check Java</button>
              <button className="btn primary" disabled={!info.valid || Boolean(busy)} onClick={() => void api('/api/profiles', { method: 'POST', body: JSON.stringify({ name, directory: info.directory, jarFile: jar, javaPath: javaPath || null, minMemory, maxMemory, jvmArgs: '', serverArgs: '', launchMode: info.suggested.launchMode, argFile: info.suggested.argFile, software: info.suggested.software, mcVersion: info.suggested.version, pluginContainer: info.suggested.pluginContainer }) }).then(() => api<MeResponse>('/api/me')).then((next) => { onDone(next); navigate('/'); }).catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Could not save the profile'))}>Save profile</button>
            </div>
            {check && <div>{check.warnings.length ? check.warnings.map((warning) => <p key={warning} style={{ color: 'var(--warn)' }}>{warning}</p>) : <p>Java looks compatible.</p>}</div>}
          </>
        )}
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        {busy && <p className="help">{busy}…</p>}
        {me.profiles.length > 0 && <button className="btn ghost" onClick={() => navigate('/')}>Back to the panel</button>}
      </div>
    </div>
  );
}
