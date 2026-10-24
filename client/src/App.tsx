import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Shell } from './components/Layout';
import { ToastProvider } from './components/ui';
import { api } from './lib/api';
import { BackupsPage } from './pages/Backups';
import { ConfigPage } from './pages/ConfigPage';
import { ConsolePage } from './pages/Console';
import { Dashboard } from './pages/Dashboard';
import { FilesPage } from './pages/Files';
import { Login } from './pages/Login';
import { MonitoringPage } from './pages/Monitoring';
import { PlayersPage } from './pages/Players';
import { PluginsPage } from './pages/Plugins';
import { SettingsPage } from './pages/Settings';
import { Setup } from './pages/Setup';
import { TasksPage } from './pages/Tasks';
import { WorldsPage } from './pages/Worlds';
import type { MeResponse } from './types';

export function App() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  useEffect(() => {
    api<MeResponse>('/api/me').then(setMe).catch(() => setMe(null));
  }, []);
  if (me === undefined) return <div className="boot"><img src="/logo.png" alt="Mineview" /></div>;
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={me ? <Navigate to={me.setupComplete ? '/' : '/setup'} replace /> : <Login onSuccess={() => api<MeResponse>('/api/me').then(setMe)} />} />
        <Route path="/setup" element={me ? <Setup me={me} onDone={(next) => setMe(next)} /> : <Navigate to="/login" replace />} />
        <Route element={me ? (me.setupComplete ? <Shell me={me} onMe={setMe} /> : <Navigate to="/setup" replace />) : <Navigate to="/login" replace />}>
          <Route index element={<Dashboard />} />
          <Route path="console" element={<ConsolePage />} />
          <Route path="players" element={<PlayersPage />} />
          <Route path="plugins" element={<PluginsPage />} />
          <Route path="worlds" element={<WorldsPage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="monitoring" element={<MonitoringPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="settings" element={<SettingsPage onMe={setMe} />} />
        </Route>
        <Route path="*" element={<Missing signedIn={Boolean(me)} />} />
      </Routes>
    </ToastProvider>
  );
}

function Missing({ signedIn }: { signedIn: boolean }) {
  const navigate = useNavigate();
  useEffect(() => { navigate(signedIn ? '/' : '/login', { replace: true }); }, [navigate, signedIn]);
  return null;
}
