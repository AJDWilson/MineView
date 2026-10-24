import { useEffect, useState } from 'react';
import { Confirm, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDuration, formatTime, show } from '../lib/format';
import type { AccessSnapshot, PlayerRow } from '../types';

export function PlayersPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'players' | 'bans' | 'access'>('players');
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [access, setAccess] = useState<AccessSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('Rule violation');
  const [selected, setSelected] = useState('');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState('');
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState('hours');
  const [pending, setPending] = useState<null | { title: string; body: string; run: () => Promise<void> }>(null);

  async function load() {
    const [playerData, accessData] = await Promise.all([
      api<{ players: PlayerRow[] }>('/api/players'),
      api<AccessSnapshot>('/api/access'),
    ]);
    setPlayers(playerData.players);
    setAccess(accessData);
  }
  useEffect(() => { void load().catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not load players', 'err')); }, [toast]);
  const shown = players.filter((player) => `${player.name} ${player.uuid ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const act = (title: string, body: string, run: () => Promise<unknown>) => setPending({ title, body, run: async () => { await run(); await load(); setPending(null); toast('Done'); } });

  return (
    <>
      <div className="row">
        <button className={tab === 'players' ? 'btn primary' : 'btn'} onClick={() => setTab('players')}>Players</button>
        <button className={tab === 'bans' ? 'btn primary' : 'btn'} onClick={() => setTab('bans')}>Bans</button>
        <button className={tab === 'access' ? 'btn primary' : 'btn'} onClick={() => setTab('access')}>Whitelist and operators</button>
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search name or UUID" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search players" />
      </div>
      {access?.permissionPlugins.length ? <p className="help">Permission plugin detected: {access.permissionPlugins.join(', ')}. Operator status is separate from that plugin’s groups.</p> : null}
      {tab === 'players' && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th>UUID</th><th>Status</th><th>Session</th><th>First seen</th><th>Last seen</th><th>Actions</th></tr></thead>
            <tbody>
              {shown.map((player) => (
                <tr key={player.name} onClick={() => setSelected(player.name)}>
                  <td>{player.name}{selected === player.name ? ' · selected' : ''}</td>
                  <td>{show(player.uuid)}</td>
                  <td>{player.online == null ? 'Unavailable' : player.online ? 'Online' : 'Offline'}</td>
                  <td>{player.online ? formatDuration(player.sessionStartedAt ? Date.now() - player.sessionStartedAt : null) : '—'}</td>
                  <td>{formatTime(player.firstSeen)}</td>
                  <td>{formatTime(player.lastSeen)}</td>
                  <td className="row">
                    <button className="btn" disabled={!player.online} onClick={() => act('Kick player', `Kick ${player.name}?`, () => api('/api/players/kick', { method: 'POST', body: JSON.stringify({ confirm: true, name: player.name, reason }) }))}>Kick</button>
                    <button className="btn" onClick={() => act('Ban player', `Ban ${player.name}? This uses the server ban list.`, () => api('/api/players/ban', { method: 'POST', body: JSON.stringify({ confirm: true, name: player.name, reason }) }))}>Ban</button>
                    <button className="btn" onClick={() => act('Temporary ban', `Ban ${player.name} and pardon them after ${amount} ${unit}. Vanilla has no temporary bans, so Mineview schedules the pardon.`, () => api('/api/players/tempban', { method: 'POST', body: JSON.stringify({ confirm: true, name: player.name, reason, value: amount, unit }) }))}>Temp ban</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="empty">No players recorded yet. Online players appear after they join a server started by Mineview.</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <input className="input" style={{ maxWidth: 180 }} value={reason} onChange={(event) => setReason(event.target.value)} aria-label="Reason" />
            <input className="input" style={{ maxWidth: 90 }} type="number" min={1} value={amount} onChange={(event) => setAmount(Number(event.target.value))} aria-label="Duration" />
            <select className="select" style={{ maxWidth: 120 }} value={unit} onChange={(event) => setUnit(event.target.value)} aria-label="Duration unit"><option>minutes</option><option>hours</option><option>days</option></select>
            <input className="input" style={{ maxWidth: 140 }} placeholder="Teleport target" value={target} onChange={(event) => setTarget(event.target.value)} aria-label="Teleport target" />
            <button className="btn" disabled={!selected} onClick={() => void api('/api/players/tp', { method: 'POST', body: JSON.stringify({ name: selected, target }) }).then(() => toast('Teleport sent')).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Teleport failed', 'err'))}>Teleport {selected || 'player'}</button>
            <input className="input" style={{ maxWidth: 180 }} placeholder="Private message" value={message} onChange={(event) => setMessage(event.target.value)} aria-label="Private message" />
            <button className="btn" disabled={!selected || !message.trim()} onClick={() => void api('/api/players/msg', { method: 'POST', body: JSON.stringify({ name: selected, message }) }).then(() => toast('Message sent')).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Message failed', 'err'))}>Message</button>
          </div>
        </div>
      )}
      {tab === 'bans' && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Reason</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              {(access?.bans ?? []).map((ban) => <tr key={ban.name}><td>{ban.name}</td><td>{show(ban.reason)}</td><td>{ban.expiresAt ? formatTime(ban.expiresAt) : show(ban.expires)}</td><td><button className="btn" onClick={() => act('Unban', `Pardon ${ban.name}?`, () => api('/api/players/pardon', { method: 'POST', body: JSON.stringify({ confirm: true, name: ban.name }) }))}>Unban</button></td></tr>)}
            </tbody>
          </table>
          {(access?.bans.length ?? 0) === 0 && <p className="empty">No banned players in banned-players.json.</p>}
        </div>
      )}
      {tab === 'access' && access && (
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <p className="help">Whitelist is {access.whitelistEnabled == null ? 'unavailable' : access.whitelistEnabled ? 'on' : 'off'}. Online mode is {access.onlineMode == null ? 'unavailable' : String(access.onlineMode)}. Granting operator gives a player substantial control of the server.</p>
          <form className="row" onSubmit={(event) => { event.preventDefault(); void api('/api/access/whitelist', { method: 'POST', body: JSON.stringify({ name }) }).then(load).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not update whitelist', 'err')); }}>
            <input className="input" placeholder="Player name" value={name} onChange={(event) => setName(event.target.value)} aria-label="Player to add" />
            <button className="btn primary">Add to whitelist</button>
            <button className="btn" type="button" onClick={() => act('Make operator', `${name} will be able to use operator commands.`, () => api('/api/access/op', { method: 'POST', body: JSON.stringify({ confirm: true, name }) }))}>Make operator</button>
          </form>
          <h3>Whitelist</h3>
          {access.whitelist.map((player) => <div key={player.uuid} className="row"><span>{player.name}</span><button className="btn" onClick={() => void api('/api/access/whitelist', { method: 'DELETE', body: JSON.stringify({ name: player.name }) }).then(load)}>Remove</button></div>)}
          <h3>Operators</h3>
          {access.ops.map((player) => <div key={player.uuid} className="row"><span>{player.name} · level {player.level}</span><button className="btn danger" onClick={() => act('Remove operator', `Remove operator from ${player.name}?`, () => api('/api/access/op', { method: 'DELETE', body: JSON.stringify({ confirm: true, name: player.name }) }))}>Revoke</button></div>)}
        </div>
      )}
      {pending && <Confirm title={pending.title} body={pending.body} danger onClose={() => setPending(null)} onConfirm={pending.run} />}
    </>
  );
}
