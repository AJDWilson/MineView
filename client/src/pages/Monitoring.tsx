import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../lib/api';
import { formatBytes, formatDuration, formatTime, show } from '../lib/format';
import type { MetricPoint, StatusSnapshot } from '../types';

export function MonitoringPage() {
  const { status } = useOutletContext<{ status: StatusSnapshot | null }>();
  const [range, setRange] = useState('6h');
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [events, setEvents] = useState<{ at: number; type: string; message: string }[]>([]);
  useEffect(() => {
    void api<{ points: MetricPoint[]; events: { at: number; type: string; message: string }[] }>(`/api/monitoring?range=${range}`).then((data) => { setPoints(data.points); setEvents(data.events); });
  }, [range]);
  return (
    <>
      <div className="row">
        <span className={`badge ${status?.health ?? 'offline'}`}>Health: {status?.health ?? 'offline'}</span>
        <select className="select" style={{ maxWidth: 140 }} value={range} onChange={(event) => setRange(event.target.value)} aria-label="History range"><option value="1h">1 hour</option><option value="6h">6 hours</option><option value="24h">24 hours</option></select>
      </div>
      <section className="grid-stats">
        <article className="card"><div className="stat-label">Process CPU</div><div className="stat-value">{status?.cpuPercent == null ? 'Unavailable' : `${status.cpuPercent.toFixed(1)}%`}</div></article>
        <article className="card"><div className="stat-label">Process memory</div><div className="stat-value">{formatBytes(status?.memoryBytes)}</div></article>
        <article className="card"><div className="stat-label">System memory free</div><div className="stat-value">{formatBytes(status?.systemMemory.free)}</div></article>
        <article className="card"><div className="stat-label">Uptime</div><div className="stat-value">{formatDuration(status?.uptimeMs)}</div></article>
        <article className="card"><div className="stat-label">Players</div><div className="stat-value">{status?.playersOnline ?? 'Unavailable'}</div></article>
        <article className="card"><div className="stat-label">Disk free</div><div className="stat-value">{formatBytes(status?.diskFree)}</div></article>
        <article className="card"><div className="stat-label">JVM</div><div className="stat-value">{show(status?.javaVersion)}</div><p className="help">TPS, MSPT, and entity counts are unavailable unless the server software or a plugin exposes them. Mineview does not invent those values.</p></article>
      </section>
      <div className="card"><Chart label="CPU %" values={points.map((point) => point.cpu)} /><Chart label="Memory" values={points.map((point) => point.memoryBytes == null ? null : point.memoryBytes / (1024 * 1024))} /><Chart label="Players" values={points.map((point) => point.players)} /></div>
      <div className="card">
        <strong>Crashes, starts, stops, backups</strong>
        {events.length === 0 && <p className="empty">No recorded events in this profile yet.</p>}
        <ul>{events.map((event) => <li key={`${event.at}-${event.type}`}>{formatTime(event.at)} · {event.type} · {event.message}</li>)}</ul>
      </div>
    </>
  );
}

function Chart({ label, values }: { label: string; values: (number | null)[] }) {
  const nums = values.filter((value): value is number => value != null);
  if (!nums.length) return <p className="help">{label}: Unavailable</p>;
  const max = Math.max(...nums, 1);
  const step = 100 / Math.max(1, values.length - 1);
  const points = values.map((value, index) => `${index * step},${100 - ((value ?? 0) / max) * 100}`).join(' ');
  return (
    <div>
      <div className="stat-label">{label}</div>
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: 80, background: 'var(--canvas)', borderRadius: 8 }}>
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={points} />
      </svg>
    </div>
  );
}
