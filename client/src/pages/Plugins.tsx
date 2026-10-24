import { useEffect, useState } from 'react';
import { Confirm, useToast } from '../components/ui';
import { api, ApiError, upload } from '../lib/api';
import { formatBytes, formatTime } from '../lib/format';
import type { CompatibilityStatus, InstalledPlugin, MarketplaceTarget, PluginPreview, PluginProjectDetail, PluginSearchHit, PluginSource, ServerSoftware } from '../types';

const SOFTWARE: ServerSoftware[] = ['paper', 'purpur', 'spigot', 'bukkit', 'folia', 'fabric', 'forge', 'neoforge', 'vanilla', 'unknown'];
const CATEGORIES = ['', 'utility', 'economy', 'chat', 'worldgen', 'management', 'optimization', 'gameplay'];
const STATUS_LABEL: Record<CompatibilityStatus, string> = {
  compatible: 'Compatible',
  possible: 'Possibly compatible',
  incompatible: 'Incompatible',
  unknown: 'Unknown',
};

export function PluginsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'discover' | 'installed' | 'upload'>('discover');
  const [target, setTarget] = useState<MarketplaceTarget | null>(null);
  const [software, setSoftware] = useState<ServerSoftware>('unknown');
  const [version, setVersion] = useState('');
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<Exclude<PluginSource, 'manual'>>('modrinth');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('relevance');
  const [strict, setStrict] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [hits, setHits] = useState<PluginSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [detail, setDetail] = useState<PluginProjectDetail | null>(null);
  const [versionId, setVersionId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ name: '', version: '', mc: '', software: 'paper', sourceUrl: '', notes: '' });
  const [acknowledge, setAcknowledge] = useState(false);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [pending, setPending] = useState<{ source: PluginSource; projectId: string; versionId: string } | null>(null);
  const [removeFile, setRemoveFile] = useState<string | null>(null);

  async function loadInstalled() {
    setInstalled((await api<{ plugins: InstalledPlugin[] }>('/api/plugins/installed')).plugins);
  }
  useEffect(() => {
    void loadInstalled().catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Could not read plugins'));
    void api<MarketplaceTarget>('/api/plugins/target').then((next) => {
      setTarget(next);
      setSoftware(next.software !== 'unknown' ? next.software : next.detectedSoftware);
      setVersion(next.mcVersion ?? next.detectedVersion ?? '');
    }).catch(() => setError('Server configuration could not be detected. Set the platform and Minecraft version below.'));
  }, []);

  async function search(nextOffset = offset) {
    setError('');
    setBusy('Searching repositories');
    setSearched(true);
    try {
      const params = new URLSearchParams({ q: query, source, sort, offset: String(nextOffset), loader: software, version });
      if (category) params.set('category', category);
      if (strict) params.set('strict', '1');
      const result = await api<{ hits: PluginSearchHit[]; total: number | null; target: MarketplaceTarget }>(`/api/plugins/search?${params}`);
      setHits(result.hits);
      setTotal(result.total);
      setOffset(nextOffset);
      setTarget(result.target);
    } catch (reason) {
      setHits([]);
      setError(reason instanceof ApiError ? reason.message : 'Search failed');
    } finally {
      setBusy('');
    }
  }

  async function saveTarget() {
    if (!target) return;
    setBusy('Saving server target');
    try {
      await api('/api/profiles/' + (await api<{ activeProfileId: string | null }>('/api/profiles')).activeProfileId, {
        method: 'PATCH',
        body: JSON.stringify({ software, mcVersion: version }),
      });
      setTarget(await api<MarketplaceTarget>('/api/plugins/target'));
      toast('Compatibility filters now use this server configuration');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not save the server target');
    } finally {
      setBusy('');
    }
  }

  const shown = hits.filter((hit) => statusFilter === 'all' || hit.compatibility === statusFilter);
  const pageSize = 12;

  return (
    <>
      <div className="row">
        <button className={tab === 'discover' ? 'btn primary' : 'btn'} onClick={() => setTab('discover')}>Marketplace</button>
        <button className={tab === 'installed' ? 'btn primary' : 'btn'} onClick={() => setTab('installed')}>Installed plugins</button>
        <button className={tab === 'upload' ? 'btn primary' : 'btn'} onClick={() => setTab('upload')}>Manual install</button>
      </div>
      <p className="help">Plugins are untrusted code that runs inside the Minecraft server. Mineview does not execute the JAR. Installing a file does not load it until the server restarts.</p>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {busy && <p className="help">{busy}…</p>}
      {tab === 'discover' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <section className="card" style={{ display: 'grid', gap: 8 }}>
            <strong>Server target</strong>
            <p className="help">Detected {target?.detectedSoftware ?? 'unknown'} {target?.detectedVersion ?? '(version unavailable)'}{target?.build ? ` · build ${target.build}` : ''}. Filters use the values below, including a manual override.</p>
            <div className="row">
              <select className="select" value={software} onChange={(event) => setSoftware(event.target.value as ServerSoftware)} aria-label="Server platform">
                {SOFTWARE.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <input className="input" style={{ maxWidth: 160 }} placeholder="Minecraft version" value={version} onChange={(event) => setVersion(event.target.value)} aria-label="Minecraft version" />
              <button className="btn" onClick={() => void saveTarget()}>Save as this server</button>
            </div>
          </section>
          <form className="card row" onSubmit={(event) => { event.preventDefault(); void search(0); }}>
            <input className="input" placeholder="Search plugins" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Plugin search" />
            <select className="select" value={source} onChange={(event) => setSource(event.target.value as typeof source)} aria-label="Repository">
              <option value="modrinth">Modrinth</option>
              <option value="hangar">Hangar</option>
              <option value="spiget">Spiget</option>
            </select>
            <select className="select" value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category">
              {CATEGORIES.map((item) => <option key={item || 'all'} value={item}>{item || 'Any category'}</option>)}
            </select>
            <select className="select" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
              <option value="relevance">Relevance</option>
              <option value="downloads">Downloads</option>
              <option value="updated">Updated</option>
            </select>
            <select className="select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Compatibility">
              <option value="all">Any compatibility</option>
              <option value="compatible">Compatible</option>
              <option value="possible">Possibly compatible</option>
              <option value="incompatible">Incompatible</option>
              <option value="unknown">Unknown</option>
            </select>
            <label><input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} /> Ask the repository to pre-filter</label>
            <button className="btn primary" disabled={Boolean(busy)}>Search</button>
          </form>
          <div className="plugin-grid">
            {shown.map((hit) => (
              <article key={`${hit.source}-${hit.projectId}`} className="card plugin-card">
                <div className="row">
                  {hit.iconUrl && <img src={hit.iconUrl} alt="" />}
                  <div>
                    <strong>{hit.title}</strong>
                    <div className="help">{hit.author}</div>
                  </div>
                </div>
                <p>{hit.description}</p>
                <div className="row">
                  <span className={`badge ${hit.compatibility}`}>{STATUS_LABEL[hit.compatibility]}</span>
                  <span className="badge">{hit.source}</span>
                </div>
                <p className="help">{hit.downloads == null ? 'Downloads unavailable' : `${hit.downloads.toLocaleString()} downloads`}{hit.rating == null ? '' : ` · rating ${hit.rating.toFixed(1)}`}</p>
                <p className="help">Latest checked release: {hit.latestVersion ?? 'Unavailable'}</p>
                <p className="help">Platforms: {hit.loaders.join(', ') || 'Unavailable'} · Minecraft: {hit.gameVersions.slice(0, 4).join(', ') || 'Unavailable'}</p>
                {hit.dependencies.length > 0 && <p className="help">Required: {hit.dependencies.map((item) => item.title || item.projectId).join(', ')}</p>}
                <p className="help">{hit.compatibilityReason}</p>
                <div className="row">
                  <a href={hit.projectUrl} target="_blank" rel="noreferrer">Project page</a>
                  <button className="btn" onClick={() => void api<PluginProjectDetail>(`/api/plugins/project?source=${hit.source}&id=${encodeURIComponent(hit.projectId)}`).then((project) => { setDetail(project); setVersionId(project.versions.find((item) => item.compatibility === 'compatible' || item.compatibility === 'possible')?.id ?? project.versions[0]?.id ?? ''); })}>Releases</button>
                  <button className="btn primary" disabled={!hit.installable || !hit.latestVersionId || Boolean(busy)} onClick={() => {
                    if (!hit.latestVersionId) return;
                    setBusy(`Checking ${hit.title}`);
                    void api<PluginPreview>('/api/plugins/preview', { method: 'POST', body: JSON.stringify({ source: hit.source, projectId: hit.projectId, versionId: hit.latestVersionId }) })
                      .then((next) => { setPreview(next); setPending({ source: hit.source, projectId: hit.projectId, versionId: hit.latestVersionId! }); })
                      .catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Could not check compatibility'))
                      .finally(() => setBusy(''));
                  }}>Install</button>
                </div>
              </article>
            ))}
          </div>
          {searched && !busy && shown.length === 0 && <p className="empty">No plugins matched. If the repository is unavailable, the error above is from that API, not a placeholder list.</p>}
          <div className="row">
            <button className="btn" disabled={offset === 0 || Boolean(busy)} onClick={() => void search(Math.max(0, offset - pageSize))}>Previous</button>
            <span className="help">{total == null ? 'Total unavailable' : `${total} results`} · showing {offset + 1}</span>
            <button className="btn" disabled={Boolean(busy) || (total != null && offset + pageSize >= total) || hits.length < pageSize} onClick={() => void search(offset + pageSize)}>Next</button>
          </div>
          {detail && (
            <div className="card" style={{ display: 'grid', gap: 8 }}>
              <strong>{detail.title}</strong>
              <p>{detail.description}</p>
              <p className="help">{detail.author} · <a href={detail.projectUrl} target="_blank" rel="noreferrer">Project</a>{detail.sourceUrl ? <> · <a href={detail.sourceUrl} target="_blank" rel="noreferrer">Source</a></> : null}</p>
              <label className="field"><span>Release</span>
                <select className="select" value={versionId} onChange={(event) => setVersionId(event.target.value)}>
                  {detail.versions.map((item) => <option key={item.id} value={item.id}>{item.versionNumber} · {STATUS_LABEL[item.compatibility]} · {(item.gameVersions || []).slice(0, 3).join(', ') || 'version unavailable'}</option>)}
                </select>
              </label>
              <p className="help">{detail.versions.find((item) => item.id === versionId)?.compatibilityReason}</p>
              <button className="btn primary" disabled={!versionId} onClick={() => {
                setBusy('Checking release');
                void api<PluginPreview>('/api/plugins/preview', { method: 'POST', body: JSON.stringify({ source: detail.source, projectId: detail.projectId, versionId }) })
                  .then((next) => { setPreview(next); setPending({ source: detail.source, projectId: detail.projectId, versionId }); })
                  .catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Could not check compatibility'))
                  .finally(() => setBusy(''));
              }}>Review selected release</button>
            </div>
          )}
        </div>
      )}
      {tab === 'installed' && (
        <div className="card table-wrap">
          <div className="row"><button className="btn" onClick={() => void api<{ updates: { file: string; version: string | null }[] }>('/api/plugins/updates', { method: 'POST', body: '{}' }).then((result) => toast(result.updates.length ? result.updates.map((item) => `${item.file} → ${item.version ?? 'newer'}`).join(', ') : 'No verified Modrinth updates')).catch((reason: unknown) => toast(reason instanceof ApiError ? reason.message : 'Update check failed', 'err'))}>Check Modrinth updates</button></div>
          <table>
            <thead><tr><th>Name</th><th>Version</th><th>File</th><th>Size</th><th>Modified</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {installed.map((plugin) => (
                <tr key={plugin.file}>
                  <td>{plugin.name}{plugin.identified ? '' : ' (unidentified)'}{plugin.source ? ` · ${plugin.source}` : ''}</td>
                  <td>{plugin.version ?? 'Unavailable'}</td>
                  <td>{plugin.file}</td>
                  <td>{formatBytes(plugin.size)}</td>
                  <td>{formatTime(plugin.modifiedAt)}</td>
                  <td>{plugin.enabled}</td>
                  <td className="row">
                    {plugin.source && plugin.source !== 'manual' && plugin.projectId && <button className="btn" onClick={() => void api<PluginProjectDetail>(`/api/plugins/project?source=${plugin.source}&id=${encodeURIComponent(plugin.projectId!)}`).then((project) => {
                      const next = project.versions.find((item) => item.compatibility === 'compatible' || item.compatibility === 'possible');
                      if (!next) { toast('No verified compatible update was returned', 'err'); return; }
                      setDetail(project);
                      setVersionId(next.id);
                      setTab('discover');
                    })}>View update</button>}
                    <button className="btn" onClick={() => void api('/api/plugins/open', { method: 'POST', body: JSON.stringify({ path: plugin.path.split(/[\\/]/).slice(0, -1).join('/') || 'plugins' }) })}>Open folder</button>
                    {plugin.configFolder && <button className="btn" onClick={() => void api('/api/plugins/open', { method: 'POST', body: JSON.stringify({ path: plugin.configFolder }) })}>Config folder</button>}
                    <button className="btn" onClick={() => void api<{ lines: string[] }>(`/api/plugins/errors?name=${encodeURIComponent(plugin.name)}`).then((result) => toast(result.lines.at(-1) || 'No matching errors in the recent log'))}>Log errors</button>
                    <a className="btn" href={`/api/files/download?path=${encodeURIComponent(plugin.path)}`}>Download</a>
                    <button className="btn" onClick={() => void api('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ file: plugin.file, enable: plugin.file.endsWith('.disabled') }) }).then(loadInstalled)}>{plugin.file.endsWith('.disabled') ? 'Enable' : 'Disable'}</button>
                    <button className="btn danger" onClick={() => setRemoveFile(plugin.file)}>Uninstall</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {installed.length === 0 && <p className="empty">No plugin JARs were found in the server plugin folder.</p>}
        </div>
      )}
      {tab === 'upload' && (
        <form className="card" style={{ display: 'grid', gap: 10 }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setFile(event.dataTransfer.files[0] ?? null); }} onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          const form = new FormData();
          form.set('file', file);
          form.set('name', meta.name);
          form.set('version', meta.version);
          form.set('minecraftVersion', meta.mc);
          form.set('software', meta.software);
          form.set('sourceUrl', meta.sourceUrl);
          form.set('notes', meta.notes);
          form.set('replace', String(replace));
          form.set('acknowledge', String(acknowledge));
          setBusy('Uploading');
          void upload('/api/plugins/upload', form).then(() => { toast('Installed. Restart the server to load it.'); setTab('installed'); return loadInstalled(); }).catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Upload failed')).finally(() => setBusy(''));
        }}>
          <p className="help">Drop a .jar here or choose a file. A .jar extension does not mean the file is safe.</p>
          <input type="file" accept=".jar" onChange={(event) => setFile(event.target.files?.[0] ?? null)} aria-label="Plugin JAR" />
          <div className="row">
            <input className="input" placeholder="Display name" value={meta.name} onChange={(event) => setMeta({ ...meta, name: event.target.value })} aria-label="Display name" />
            <input className="input" placeholder="Plugin version" value={meta.version} onChange={(event) => setMeta({ ...meta, version: event.target.value })} aria-label="Plugin version" />
            <input className="input" placeholder="Minecraft version" value={meta.mc} onChange={(event) => setMeta({ ...meta, mc: event.target.value })} aria-label="Minecraft version" />
            <input className="input" placeholder="Server software" value={meta.software} onChange={(event) => setMeta({ ...meta, software: event.target.value })} aria-label="Server software" />
          </div>
          <input className="input" placeholder="Optional source URL (stored only, not downloaded)" value={meta.sourceUrl} onChange={(event) => setMeta({ ...meta, sourceUrl: event.target.value })} aria-label="Source URL" />
          <input className="input" placeholder="Optional dependency notes" value={meta.notes} onChange={(event) => setMeta({ ...meta, notes: event.target.value })} aria-label="Dependency notes" />
          <label><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /> Replace an existing file and keep a backup outside the plugins folder</label>
          <label><input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} /> I trust this file even if plugin metadata cannot be read</label>
          <button className="btn primary" disabled={!file || Boolean(busy)}>Upload and install</button>
        </form>
      )}
      {pending && preview && (
        <Confirm title="Install plugin" confirmLabel="Download and install" onClose={() => { setPending(null); setPreview(null); }} onConfirm={async () => {
          setBusy('Downloading');
          try {
            const result = await api<{ files: string[]; skipped: string[]; restartRequired: boolean }>('/api/plugins/install', { method: 'POST', body: JSON.stringify({ confirm: true, source: pending.source, projectId: pending.projectId, versionId: pending.versionId, includeDependencies: true }) });
            toast(`Installed ${result.files.join(', ')}. Restart the server to load ${result.restartRequired ? 'it' : 'the plugin'}.${result.skipped.length ? ` Skipped: ${result.skipped.join(', ')}` : ''}`);
            setPending(null);
            setPreview(null);
            await loadInstalled();
          } catch (reason) {
            toast(reason instanceof ApiError ? reason.message : 'Install failed', 'err');
          } finally {
            setBusy('');
          }
        }} body={`${preview.warnings.join(' ')} Author and source are on the project page. Required dependencies: ${preview.dependencies.map((item) => item.title || item.projectId).join(', ') || 'none listed'}. The file is saved into the server plugin folder and is not loaded until restart.`} />
      )}
      {removeFile && (
        <Confirm title="Uninstall plugin" danger confirmLabel="Uninstall" onClose={() => setRemoveFile(null)} onConfirm={async () => {
          await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ confirm: true, file: removeFile, keepConfig: true }) });
          toast('Removed. Restart required to unload it from a running server.');
          setRemoveFile(null);
          await loadInstalled();
        }} body={`${removeFile} will be moved to the backup folder. Its configuration folder is kept. This does not unload the plugin from a running server.`} />
      )}
    </>
  );
}
