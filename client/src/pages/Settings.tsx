import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type { DiagnosticCheck, MeResponse, Profile, SettingsPublic } from '../types';

export function SettingsPage({ onMe }: { onMe: (me: MeResponse) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsPublic | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [profile, setProfile] = useState<Profile | null>(null);

  async function load() {
    const [nextSettings, nextProfiles, diagnostics, me] = await Promise.all([
      api<SettingsPublic>('/api/settings'),
      api<{ profiles: Profile[] }>('/api/profiles'),
      api<{ checks: DiagnosticCheck[] }>('/api/diagnostics'),
      api<MeResponse>('/api/me'),
    ]);
    setSettings(nextSettings);
    setProfiles(nextProfiles.profiles);
    setChecks(diagnostics.checks);
    setProfile(nextProfiles.profiles.find((item) => item.id === me.activeProfileId) ?? null);
    onMe(me);
  }
  useEffect(() => { void load().catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not load settings', 'err')); }, [toast]);
  if (!settings) return <div className="card">Loading settings…</div>;
  if (!profile) return <div className="card">No active server profile. <button className="btn" onClick={() => navigate('/setup')}>Open setup</button></div>;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <form className="card" style={{ display: 'grid', gap: 10 }} onSubmit={(event) => {
        event.preventDefault();
        void api('/api/profiles/' + profile.id, { method: 'PATCH', body: JSON.stringify(profile) }).then(() => toast('Server profile saved')).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not save the profile', 'err'));
      }}>
        <h2>Active server</h2>
        <label className="field"><span>Name</span><input className="input" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
        <label className="field"><span>Java executable</span><input className="input" value={profile.javaPath ?? ''} onChange={(event) => setProfile({ ...profile, javaPath: event.target.value })} /></label>
        <div className="row">
          <label className="field"><span>Minimum memory</span><input className="input" value={profile.minMemory} onChange={(event) => setProfile({ ...profile, minMemory: event.target.value })} /></label>
          <label className="field"><span>Maximum memory</span><input className="input" value={profile.maxMemory} onChange={(event) => setProfile({ ...profile, maxMemory: event.target.value })} /></label>
        </div>
        <label className="field"><span>JVM arguments</span><input className="input" value={profile.jvmArgs} onChange={(event) => setProfile({ ...profile, jvmArgs: event.target.value })} /></label>
        <label className="field"><span>Server arguments</span><input className="input" value={profile.serverArgs} onChange={(event) => setProfile({ ...profile, serverArgs: event.target.value })} /></label>
        <label><input type="checkbox" checked={profile.autoRestart} onChange={(event) => setProfile({ ...profile, autoRestart: event.target.checked })} /> Restart after a crash</label>
        <div className="row">
          <label className="field"><span>Retry limit</span><input className="input" type="number" value={profile.autoRestartMax} onChange={(event) => setProfile({ ...profile, autoRestartMax: Number(event.target.value) })} /></label>
          <label className="field"><span>Cooldown seconds</span><input className="input" type="number" value={profile.autoRestartCooldown} onChange={(event) => setProfile({ ...profile, autoRestartCooldown: Number(event.target.value) })} /></label>
          <label className="field"><span>Restart delay seconds</span><input className="input" type="number" value={profile.restartDelay} onChange={(event) => setProfile({ ...profile, restartDelay: Number(event.target.value) })} /></label>
        </div>
        <button className="btn primary">Save server profile</button>
      </form>
      <form className="card" style={{ display: 'grid', gap: 10 }} onSubmit={(event) => {
        event.preventDefault();
        document.documentElement.dataset.theme = settings.theme;
        document.documentElement.dataset.accent = settings.accent;
        void api('/api/settings', { method: 'PUT', body: JSON.stringify({ ...settings, confirmRemote: true }) }).then(() => toast('Settings saved. Restart Mineview to apply a host or port change.')).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not save settings', 'err'));
      }}>
        <h2>Application</h2>
        <div className="row">
          <label className="field"><span>Theme</span><select className="select" value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value as 'dark' | 'light' })}><option value="dark">Dark</option><option value="light">Light</option></select></label>
          <label className="field"><span>Accent</span><select className="select" value={settings.accent} onChange={(event) => setSettings({ ...settings, accent: event.target.value as SettingsPublic['accent'] })}><option value="grass">Grass</option><option value="emerald">Emerald</option><option value="copper">Copper</option><option value="amethyst">Amethyst</option></select></label>
          <label className="field"><span>Console lines</span><input className="input" type="number" value={settings.consoleBuffer} onChange={(event) => setSettings({ ...settings, consoleBuffer: Number(event.target.value) })} /></label>
        </div>
        <label className="field"><span>Backup folder</span><input className="input" value={settings.backupDir} onChange={(event) => setSettings({ ...settings, backupDir: event.target.value })} /></label>
        <div className="row">
          <label className="field"><span>Retention</span><input className="input" type="number" value={settings.backupRetention} onChange={(event) => setSettings({ ...settings, backupRetention: Number(event.target.value) })} /></label>
          <label className="field"><span>CPU warning %</span><input className="input" type="number" value={settings.cpuWarnPercent} onChange={(event) => setSettings({ ...settings, cpuWarnPercent: Number(event.target.value) })} /></label>
          <label className="field"><span>Disk warning %</span><input className="input" type="number" value={settings.diskWarnPercent} onChange={(event) => setSettings({ ...settings, diskWarnPercent: Number(event.target.value) })} /></label>
        </div>
        <label><input type="checkbox" checked={settings.excludeLogs} onChange={(event) => setSettings({ ...settings, excludeLogs: event.target.checked })} /> Exclude logs from backups</label>
        <label><input type="checkbox" checked={settings.modrinthEnabled} onChange={(event) => setSettings({ ...settings, modrinthEnabled: event.target.checked })} /> Modrinth</label>
        <label><input type="checkbox" checked={settings.hangarEnabled} onChange={(event) => setSettings({ ...settings, hangarEnabled: event.target.checked })} /> Hangar</label>
        <label><input type="checkbox" checked={settings.spigetEnabled} onChange={(event) => setSettings({ ...settings, spigetEnabled: event.target.checked })} /> Spiget</label>
        <label className="field"><span>Discord webhook</span><input className="input" value={settings.discordWebhook} onChange={(event) => setSettings({ ...settings, discordWebhook: event.target.value })} placeholder="https://discord.com/api/webhooks/…" /></label>
        <label><input type="checkbox" checked={settings.allowRemote} onChange={(event) => setSettings({ ...settings, allowRemote: event.target.checked })} /> Allow non-loopback binding after restart</label>
        <div className="row">
          <label className="field"><span>Bind host</span><input className="input" value={settings.host} onChange={(event) => setSettings({ ...settings, host: event.target.value })} /></label>
          <label className="field"><span>Port</span><input className="input" type="number" value={settings.port} onChange={(event) => setSettings({ ...settings, port: Number(event.target.value) })} /></label>
        </div>
        <p className="help">Currently listening on {settings.bindHost}:{settings.bindPort}. The panel binds to 127.0.0.1 until remote access is enabled and Mineview is restarted.</p>
        <button className="btn primary">Save application settings</button>
      </form>
      <form className="card row" onSubmit={(event) => { event.preventDefault(); void api('/api/settings/password', { method: 'POST', body: JSON.stringify(passwords) }).then(() => toast('Password changed')).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Password change failed', 'err')); }}>
        <input className="input" type="password" placeholder="Current password" value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} aria-label="Current password" />
        <input className="input" type="password" placeholder="New password" value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })} aria-label="New password" />
        <button className="btn">Change password</button>
      </form>
      <div className="card">
        <div className="row"><h2>Profiles</h2><button className="btn" onClick={() => navigate('/setup')}>Add server</button></div>
        {profiles.map((item) => <div key={item.id} className="row"><span>{item.name} · {item.directory}</span><button className="btn danger" onClick={() => void api(`/api/profiles/${item.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }).then(load)}>Delete</button></div>)}
      </div>
      <div className="card">
        <h2>Diagnostics</h2>
        {checks.map((check) => <p key={check.id}><strong>{check.name}:</strong> {check.status} — {check.message} {check.hint ? `(${check.hint})` : ''}</p>)}
        <button className="btn" onClick={() => void load()}>Run checks again</button>
      </div>
    </div>
  );
}
