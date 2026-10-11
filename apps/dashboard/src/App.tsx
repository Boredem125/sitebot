import { useCallback, useEffect, useState } from 'react';
import type { User } from '@sitebot/shared';
import { ApiRequestError, logout, me, setUnauthorizedHandler } from './api';
import { Button, ErrorState, Notice, Spinner } from './components/ui';
import { errorMessage } from './lib/format';
import { navigate, siteHref, sitesHref, useRoute } from './lib/route';
import { AuthPage } from './pages/AuthPage';
import { SitePage } from './pages/SitePage';
import { SitesPage } from './pages/SitesPage';

type Session =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'signed_out'; expired: boolean }
  | { status: 'signed_in'; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSession({ status: 'loading' });
    me().then(
      (user) => {
        if (!cancelled) setSession({ status: 'signed_in', user });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          setSession({ status: 'signed_out', expired: false });
        } else {
          setSession({ status: 'error', error });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Any 401 on a data call means the cookie is gone or expired: back to sign-in.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession((prev) => (prev.status === 'signed_in' ? { status: 'signed_out', expired: true } : prev));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const onSignedOut = useCallback(() => {
    navigate(sitesHref);
    setSession({ status: 'signed_out', expired: false });
  }, []);

  if (session.status === 'loading') {
    return (
      <main className="center-screen">
        <Spinner />
      </main>
    );
  }
  if (session.status === 'error') {
    return (
      <main className="center-screen">
        <ErrorState error={session.error} onRetry={() => setAttempt((n) => n + 1)} />
      </main>
    );
  }
  if (session.status === 'signed_out') {
    return <AuthPage expired={session.expired} onAuthed={(user) => setSession({ status: 'signed_in', user })} />;
  }
  return <Shell user={session.user} onSignedOut={onSignedOut} />;
}

function Shell({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const route = useRoute();
  const [busy, setBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function onLogout(): Promise<void> {
    setBusy(true);
    setLogoutError(null);
    try {
      await logout();
      onSignedOut();
    } catch (err) {
      // A 401 here means the session was already gone, which is the goal anyway.
      if (err instanceof ApiRequestError && err.status === 401) onSignedOut();
      else setLogoutError(`Could not log out. ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={sitesHref}>
            <span className="brand-mark" aria-hidden="true" />
            Sitebot
          </a>
          <div className="topbar-user">
            <span className="topbar-email" title={user.email}>
              {user.email}
            </span>
            <Button variant="ghost" busy={busy} onClick={() => void onLogout()}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="page">
        {logoutError && <Notice kind="error">{logoutError}</Notice>}
        {route.name === 'sites' && <SitesPage onCreated={(site) => navigate(siteHref(site.id, 'install'))} />}
        {route.name === 'site' && <SitePage key={route.id} siteId={route.id} tab={route.tab} />}
        {route.name === 'not_found' && (
          <div className="state state-empty">
            <p className="state-title">Page not found</p>
            <p>
              <a href={sitesHref}>Back to your sites</a>
            </p>
          </div>
        )}
      </main>
    </>
  );
}
