import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface ToastItem { id: number; text: string; tone: 'ok' | 'err' }
const ToastContext = createContext<(text: string, tone?: 'ok' | 'err') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, text, tone }]);
    setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {items.map((item) => <div key={item.id} className="toast" style={{ borderColor: item.tone === 'err' ? 'var(--danger)' : undefined }}>{item.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
    </header>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-back" role="presentation" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>{title}</strong>
          <button className="btn ghost" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel = 'Confirm', danger = false, onConfirm, onClose }: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="help">{body}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={danger ? 'btn danger' : 'btn primary'} onClick={() => void onConfirm()}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
