import { useEffect, useState } from 'react';
import { useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatTime } from '../lib/format';
import type { TaskInfo } from '../types';

export function TasksPage() {
  const toast = useToast();
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [form, setForm] = useState({ name: 'Nightly backup', type: 'backup', mode: 'daily', time: '04:00', intervalMinutes: 360, command: 'say Scheduled command', countdownSeconds: 30, kind: 'full' });
  async function load() { setTasks((await api<{ tasks: TaskInfo[] }>('/api/tasks')).tasks); }
  useEffect(() => { void load().catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not load tasks', 'err')); }, [toast]);
  return (
    <div className="card" style={{ display: 'grid', gap: 12 }}>
      <p className="help">Schedules survive an application restart. Overlapping backups and restarts are skipped. Crash recovery is configured per server in Settings, not as a destructive task.</p>
      <form className="row" onSubmit={(event) => {
        event.preventDefault();
        void api('/api/tasks', { method: 'POST', body: JSON.stringify({
          name: form.name,
          type: form.type,
          enabled: true,
          schedule: form.mode === 'interval' ? { mode: 'interval', intervalMinutes: form.intervalMinutes } : { mode: 'daily', time: form.time },
          payload: { command: form.command, countdownSeconds: form.countdownSeconds, kind: form.kind },
        }) }).then(load).catch((error: unknown) => toast(error instanceof ApiError ? error.message : 'Could not save the task', 'err'));
      }}>
        <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} aria-label="Task name" />
        <select className="select" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} aria-label="Task type">
          <option value="backup">Backup</option><option value="restart">Restart</option><option value="shutdown">Shutdown</option><option value="startup">Startup</option><option value="command">Command</option>
        </select>
        <select className="select" value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })} aria-label="Schedule mode"><option value="daily">Daily</option><option value="interval">Interval</option></select>
        {form.mode === 'daily' ? <input className="input" type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} aria-label="Time" /> : <input className="input" type="number" min={1} value={form.intervalMinutes} onChange={(event) => setForm({ ...form, intervalMinutes: Number(event.target.value) })} aria-label="Interval minutes" />}
        {form.type === 'command' && <input className="input" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} aria-label="Minecraft command" />}
        {form.type === 'restart' && <input className="input" type="number" min={0} value={form.countdownSeconds} onChange={(event) => setForm({ ...form, countdownSeconds: Number(event.target.value) })} aria-label="Countdown seconds" />}
        <button className="btn primary">Add task</button>
      </form>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Next</th><th>Last result</th><th></th></tr></thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>{task.name}</td>
              <td>{task.type} · {task.enabled ? 'enabled' : 'disabled'}</td>
              <td>{formatTime(task.nextRun)}</td>
              <td>{task.lastStatus ? `${task.lastStatus}: ${task.lastMessage ?? ''}` : 'Not run yet'} {task.lastRun ? `· ${formatTime(task.lastRun)}` : ''}</td>
              <td className="row">
                <button className="btn" onClick={() => void api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !task.enabled }) }).then(load)}> {task.enabled ? 'Disable' : 'Enable'}</button>
                <button className="btn danger" onClick={() => void api(`/api/tasks/${task.id}`, { method: 'DELETE' }).then(load)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && <p className="empty">No scheduled tasks.</p>}
    </div>
  );
}
