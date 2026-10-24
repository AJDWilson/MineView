import { useState } from 'react';
import { api, ApiError } from '../lib/api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="content" style={{ maxWidth: 440, margin: '10vh auto' }}>
      <div className="card" style={{ display: 'grid', gap: 14 }}>
        <div>
          <h1 style={{ margin: 0 }}>Mineview</h1>
          <p className="help">Sign in to the local Minecraft control panel. The first password is in <code>data/initial-password.txt</code>.</p>
        </div>
        <form className="field" onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
            .then(onSuccess)
            .catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Sign-in failed'))
            .finally(() => setBusy(false));
        }}>
          <span>Password</span>
          <input className="input" type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} aria-label="Password" />
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          <button className="btn primary" disabled={busy || !password} type="submit">Sign in</button>
        </form>
      </div>
    </div>
  );
}
