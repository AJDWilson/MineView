import { useState } from 'react';
import { api, ApiError } from '../lib/api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-screen">
      <img className="auth-logo" src="/logo.png" alt="Mineview" />
      <form className="card auth-card" onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
          .then(onSuccess)
          .catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Sign-in failed'))
          .finally(() => setBusy(false));
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Sign in</h1>
          <p className="help">Local Minecraft control. The first password is in <code>data/initial-password.txt</code>.</p>
        </div>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} aria-label="Password" />
        </label>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        <button className="btn primary" disabled={busy || !password} type="submit">Sign in</button>
      </form>
    </div>
  );
}
