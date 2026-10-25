import { Activity, Archive, CalendarClock, FolderTree, LayoutDashboard, Menu, Puzzle, Settings, SquareTerminal, Users, Globe, SlidersHorizontal } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { MeResponse, Profile, StatusSnapshot } from '../types';

const links = [
  ['/', 'Dashboard', LayoutDashboard],
  ['/console', 'Console', SquareTerminal],
  ['/players', 'Players', Users],
  ['/plugins', 'Plugins', Puzzle],
  ['/worlds', 'Worlds', Globe],
  ['/files', 'Files', FolderTree],
  ['/config', 'Configuration', SlidersHorizontal],
  ['/backups', 'Backups', Archive],
  ['/monitoring', 'Monitoring', Activity],
  ['/tasks', 'Scheduled Tasks', CalendarClock],
  ['/settings', 'Settings', Settings],
] as const;

export function Shell({ me, onMe }: { me: MeResponse; onMe: (me: MeResponse) => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = me.theme;
    document.documentElement.dataset.accent = me.accent;
  }, [me.theme, me.accent]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const next = await api<StatusSnapshot>('/api/server/status');
        if (!stop) setStatus(next);
      } catch {
        // The next poll reports the failure.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => { stop = true; clearInterval(timer); };
  }, [me.activeProfileId]);

  async function activate(id: string) {
    await api(`/api/profiles/${id}/activate`, { method: 'POST', body: '{}' });
    onMe(await api<MeResponse>('/api/me'));
  }

  return (
    <div className="shell">
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <img className="brand-mark" src="/image-logo.png" alt="" />
          <img className="brand-word" src="/text-logo.png" alt="Mineview" />
        </div>
        <nav className="nav">
          {links.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} onClick={() => setOpen(false)}>
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="btn menu-btn" onClick={() => setOpen((value) => !value)} aria-label="Open menu"><Menu size={16} /></button>
            <label className="server-switch">
              <span>Server</span>
              <select className="select" value={me.activeProfileId ?? ''} onChange={(event) => void activate(event.target.value)} aria-label="Active server">
                {me.profiles.map((profile: Profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>
            <span className={`badge ${status?.status ?? 'offline'}`}>{status?.status ?? 'offline'}</span>
          </div>
        </header>
        <div className="content">
          <Outlet context={{ status, refreshMe: async () => onMe(await api<MeResponse>('/api/me')) }} />
        </div>
      </div>
    </div>
  );
}
