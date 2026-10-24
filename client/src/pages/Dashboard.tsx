import { Play, RotateCcw, Skull, Square } from 'lucide-react';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Confirm, Modal, PageHeader, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatBytes, formatDuration, formatTime, show } from '../lib/format';
import type { StatusSnapshot } from '../types';

export function Dashboard() {
  const { status } = useOutletContext<{ status: StatusSnapshot | null }>();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'restart' | 'kill' | null>(null);
  const [killText, setKillText] = useState('');
  if (!status) return <div className="card">Loading server status…</div>;
  const run = async (path: string, body?: unknown) => {
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      toast('Command sent to the server');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Request failed', 'err');
    }
  };
  return (
    <>
      <PageHeader title="Dashboard">Live status for the selected server. Values that cannot be read stay unavailable.</PageHeader>
      <div className="card row">
        <button className="btn primary" disabled={!status.canStart} onClick={() => void run('/api/server/start')}><Play size={16} /> Start</button>
        <button className="btn" disabled={!status.canStop} onClick={() => void run('/api/server/stop')}><Square size={16} /> Stop</button>
        <button className="btn" disabled={!status.canRestart} onClick={() => setConfirm('restart')}><RotateCcw size={16} /> Restart</button>
        <button className="btn danger" disabled={!status.canKill} onClick={() => setConfirm('kill')}><Skull size={16} /> Kill</button>
      </div>
      {status.warnings.map((warning) => <div key={warning} className="card" style={{ borderColor: 'var(--warn)' }}>{warning}</div>)}
      <section className="grid-stats">
        <Stat label="Status" value={status.status} />
        <Stat label="Software" value={status.software ? `${status.software} ${status.mcVersion ?? ''}`.trim() : 'Unavailable'} />
        <Stat label="Players" value={status.playersOnline == null ? 'Unavailable' : `${status.playersOnline} / ${show(status.maxPlayers)}`} />
        <Stat label="CPU" value={status.cpuPercent == null ? 'Unavailable' : `${status.cpuPercent.toFixed(1)}%`} />
        <Stat label="RAM" value={formatBytes(status.memoryBytes)} />
        <Stat label="Uptime" value={formatDuration(status.uptimeMs)} />
        <Stat label="Address" value={status.port == null ? 'Unavailable' : `${status.address ?? '0.0.0.0'}:${status.port}`} />
        <Stat label="World" value={show(status.world)} />
        <Stat label="World size" value={status.worldSizeState === 'ready' ? formatBytes(status.worldSize) : status.worldSizeState === 'loading' ? 'Calculating…' : 'Unavailable'} />
        <Stat label="Plugins" value={status.pluginCount == null ? (status.pluginNote ?? 'Unavailable') : String(status.pluginCount)} />
        <Stat label="Disk free" value={formatBytes(status.diskFree)} />
        <Stat label="Last backup" value={status.lastBackup ? formatTime(status.lastBackup.at) : 'None'} />
      </section>
      <div className="grid-stats">
        <div className="card">
          <strong>Recent console</strong>
          {status.recentLogs.length === 0 && <p className="empty">No console output yet.</p>}
          <div className="console" style={{ maxHeight: 240, marginTop: 10 }}>
            {status.recentLogs.map((line) => <div key={line.id} className={line.level}>{line.text}</div>)}
          </div>
        </div>
        <div className="card">
          <strong>Recent players</strong>
          {status.recentPlayers.length === 0 && <p className="empty">No join or leave events have been recorded.</p>}
          <ul>{status.recentPlayers.map((event) => <li key={`${event.at}-${event.name}`}>{event.name} {event.event} · {formatTime(event.at)}</li>)}</ul>
          {status.exitCode != null && <p>Last exit code: {status.exitCode}</p>}
          {status.operation && <p>Current operation: {status.operation}</p>}
        </div>
      </div>
      {confirm === 'restart' && <Confirm title="Restart server" body="The server will be stopped with the stop command, then started again after the configured delay." confirmLabel="Restart" onClose={() => setConfirm(null)} onConfirm={async () => { await run('/api/server/restart'); setConfirm(null); }} />}
      {confirm === 'kill' && (
        <Modal title="Force stop" onClose={() => setConfirm(null)}>
          <p>Forcibly terminating the server can corrupt world data. Type KILL to continue. This only targets a process Mineview started.</p>
          <input className="input" value={killText} onChange={(event) => setKillText(event.target.value)} aria-label="Type KILL" />
          <button className="btn danger" disabled={killText !== 'KILL'} onClick={() => void run('/api/server/kill', { confirm: 'KILL' }).then(() => setConfirm(null))}>Kill process</button>
        </Modal>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <article className="card"><div className="stat-label">{label}</div><div className="stat-value">{value}</div></article>;
}
