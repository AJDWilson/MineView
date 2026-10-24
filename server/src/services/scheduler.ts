import type { ScheduleSpec, TaskInfo } from '../../../shared/types.ts';
import type { AppDb } from '../db.ts';
import { newId } from '../db.ts';
import { HttpError } from '../util/errors.ts';
import { sanitizeConsoleCommand } from '../util/command.ts';
import { computeNextRun } from '../util/schedule.ts';
import { createBackup } from './backups.ts';
import { currentOperation } from './locks.ts';
import { notifyDiscord } from './notify.ts';
import type { ProcessManager } from './processManager.ts';
import { expireTempBans } from './players.ts';

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    private readonly db: AppDb,
    private readonly proc: ProcessManager,
    private readonly backupDir: () => string,
    private readonly historyDir: (profileId: string) => string,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((error: unknown) => {
      this.db.addEvent(null, 'scheduler', error instanceof Error ? error.message : 'Scheduler tick failed');
    }), 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()): Promise<void> {
    await expireTempBans(this.db, this.proc, (profile) => this.historyDir(profile.id));
    for (const task of this.db.listTasks()) {
      if (!task.enabled || !task.nextRun || task.nextRun > now || this.running.has(task.id)) continue;
      if (currentOperation(task.profileId)) continue;
      this.running.add(task.id);
      try {
        await this.run(task);
        const next = computeNextRun(task.schedule, Date.now());
        this.db.saveTask({ ...task, lastRun: Date.now(), lastStatus: 'ok', lastMessage: 'Completed', nextRun: next });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Task failed';
        const next = computeNextRun(task.schedule, Date.now());
        this.db.saveTask({ ...this.db.getTask(task.id) ?? task, lastRun: Date.now(), lastStatus: 'failed', lastMessage: message, nextRun: next });
      } finally {
        this.running.delete(task.id);
      }
    }
  }

  private async run(task: TaskInfo): Promise<void> {
    const profile = this.db.getProfile(task.profileId);
    if (!profile) throw new HttpError(404, 'Server profile no longer exists', 'NO_PROFILE');
    const settings = this.db.getSettings();
    if (task.type === 'backup') {
      const kind = task.payload.kind === 'worlds' || task.payload.kind === 'plugins' || task.payload.kind === 'config' ? task.payload.kind : 'full';
      await createBackup(this.db, this.proc, profile, this.backupDir(), kind, task.name, settings.excludeLogs);
      await notifyDiscord(settings.discordWebhook, `Mineview backup finished for ${profile.name}`);
      return;
    }
    if (task.type === 'command') {
      const command = sanitizeConsoleCommand(task.payload.command ?? '');
      this.proc.sendCommand(profile, command);
      return;
    }
    if (task.type === 'startup') {
      await this.proc.start(profile);
      await notifyDiscord(settings.discordWebhook, `Mineview started ${profile.name}`);
      return;
    }
    if (task.type === 'shutdown') {
      await this.proc.stop(profile);
      await notifyDiscord(settings.discordWebhook, `Mineview stopped ${profile.name}`);
      return;
    }
    const countdown = Math.max(0, Math.min(300, task.payload.countdownSeconds ?? 0));
    if (countdown > 0 && this.proc.snapshot(profile.id).managed === 'attached') {
      this.proc.sendCommand(profile, `say Server restarting in ${countdown} seconds`);
      await new Promise((resolve) => setTimeout(resolve, countdown * 1000));
    }
    await this.proc.restart(profile);
    await notifyDiscord(settings.discordWebhook, `Mineview restarted ${profile.name}`);
  }
}

export function createTask(db: AppDb, input: Omit<TaskInfo, 'id' | 'lastRun' | 'lastStatus' | 'lastMessage' | 'nextRun'> & { schedule: ScheduleSpec }): TaskInfo {
  if (input.type === 'command') sanitizeConsoleCommand(input.payload.command ?? '');
  const task: TaskInfo = {
    ...input,
    id: newId(),
    lastRun: null,
    lastStatus: null,
    lastMessage: null,
    nextRun: input.enabled ? computeNextRun(input.schedule) : null,
  };
  db.saveTask(task);
  return task;
}
