import { useEffect, useState } from 'react';
import { LoginPage, type AuthMethod } from './auth/LoginPage';
import { ChatPage } from './chat/ChatPage';
import './styles.css';

export interface Me {
  sub: string;
  email?: string;
  name?: string;
  roles: string[];
  authMethod?: AuthMethod;
  apiKeyName?: string;
  dashboardBaseUrl?: string;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    fetch('/auth/me')
      .then((r) => {
        if (r.status === 401) {
          return null;
        }
        if (!r.ok) throw new Error(`me failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data) setMe(data as Me);
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) {
    return <div className="center-note">Loading…</div>;
  }
  if (!me) {
    return <LoginPage onAuthenticated={(user) => setMe(user)} />;
  }
  return <ChatPage me={me} onLogout={() => setMe(null)} />;
}
