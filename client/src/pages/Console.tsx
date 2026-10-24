import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { PageHeader, useToast } from '../components/ui';
import { api } from '../lib/api';
import type { LogLine, StatusSnapshot } from '../types';

export function ConsolePage() {
  const { status } = useOutletContext<{ status: StatusSnapshot | null }>();
  const toast = useToast();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('all');
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<string[]>(() => JSON.parse(localStorage.getItem('mineview.history') || '[]') as string[]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [cutoff, setCutoff] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer = 0;
    let closed = false;
    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}//${location.host}/ws`);
      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(connect, 1500);
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; lines?: LogLine[]; line?: LogLine; error?: string };
        if (message.type === 'hello' && message.lines) setLines(message.lines);
        if (message.type === 'line' && message.line) setLines((current) => [...current, message.line!].slice(-4000));
        if (message.type === 'error' && message.error) toast(message.error, 'err');
      };
    };
    connect();
    return () => { closed = true; window.clearTimeout(timer); socket?.close(); };
  }, [toast]);

  useEffect(() => {
    if (!stick.current || paused) return;
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines, paused]);

  const visible = lines.filter((line) => line.id > cutoff && (level === 'all' || line.level === level || (level === 'error' && line.level === 'stack')) && (!filter || line.text.toLowerCase().includes(filter.toLowerCase())));

  function submit(command: string) {
    const next = [command, ...history.filter((item) => item !== command)].slice(0, 100);
    setHistory(next);
    localStorage.setItem('mineview.history', JSON.stringify(next));
    setHistoryIndex(-1);
    setDraft('');
    api('/api/server/command', { method: 'POST', body: JSON.stringify({ command }) }).catch((error: unknown) => toast(error instanceof Error ? error.message : 'Command failed', 'err'));
  }

  return (
    <>
    <PageHeader title="Console">Output from the server process. Commands are written to its input when Mineview owns the process.</PageHeader>
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Live output</strong>
        <span className={`badge ${connected ? 'online' : 'offline'}`}>{connected ? 'Connected' : 'Reconnecting'}</span>
      </div>
      {status?.commandBlockReason && <p className="help">{status.commandBlockReason}</p>}
      <div className="row">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter console" />
        <select className="select" style={{ maxWidth: 160 }} value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Level">
          <option value="all">All</option><option value="warn">Warnings</option><option value="error">Errors</option>
        </select>
        <button className="btn" onClick={() => setPaused((value) => !value)}>{paused ? 'Resume scroll' : 'Pause scroll'}</button>
        <button className="btn" onClick={() => setCutoff(lines.at(-1)?.id ?? 0)}>Clear view</button>
        <button className="btn" onClick={() => void navigator.clipboard.writeText(visible.map((line) => line.text).join('\n')).then(() => toast('Copied'))}>Copy</button>
        <a className="btn" href="/api/files/download?path=logs/latest.log">Download latest.log</a>
      </div>
      <div ref={box} className="console" onScroll={(event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {visible.length === 0 && <div className="help">No matching console lines.</div>}
        {visible.map((line) => <div key={line.id} className={line.level}><span className="help">{new Date(line.ts).toLocaleTimeString()} </span>{line.text}</div>)}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) submit(draft.trim()); }}>
        <input className="input" value={draft} placeholder={status?.canCommand ? 'Enter a Minecraft command' : 'Console commands are unavailable'} disabled={!status?.canCommand} aria-label="Command"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              const next = Math.min(history.length - 1, historyIndex + 1);
              setHistoryIndex(next);
              setDraft(history[next] ?? draft);
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              const next = Math.max(-1, historyIndex - 1);
              setHistoryIndex(next);
              setDraft(next === -1 ? '' : history[next] ?? '');
            }
          }} />
      </form>
    </div>
    </>
  );
}
