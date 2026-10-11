import { useState } from 'react';
import type { FormEvent } from 'react';
import type { User } from '@sitebot/shared';
import { ApiRequestError, login, requestReset, signup } from '../api';
import { Button, Notice } from '../components/ui';
import { errorMessage } from '../lib/format';

// `forgot` is a step of logging in, so it sits under the "Log in" tab rather than getting its own.
type Mode = 'login' | 'signup' | 'forgot';

function authError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 409) return 'An account with this email already exists. Log in instead.';
    if (err.status === 401) return 'Wrong email or password.';
    if (err.status === 429) {
      return err.retryAfter !== undefined
        ? `Too many attempts. Try again in ${err.retryAfter} s.`
        : 'Too many attempts. Try again shortly.';
    }
  }
  return errorMessage(err);
}

export function AuthPage({ expired, onAuthed }: { expired: boolean; onAuthed: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: Mode): void {
    setMode(next);
    setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (mode === 'forgot') return;
    setBusy(true);
    setError(null);
    try {
      const body = { email: email.trim(), password };
      onAuthed(await (mode === 'login' ? login(body) : signup(body)));
    } catch (err) {
      setError(authError(err));
      setBusy(false);
    }
  }

  const tab = mode === 'signup' ? 'signup' : 'login';

  return (
    <main className="center-screen">
      <div className="auth">
        <h1 className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true" />
          Sitebot
        </h1>
        <p className="muted auth-tagline">An AI answer bot for your website, trained on your own content.</p>

        <section className="card auth-card">
          <div className="seg" role="tablist" aria-label="Account">
            <button
              type="button"
              role="tab"
              id="auth-tab-login"
              aria-selected={tab === 'login'}
              aria-controls="auth-panel"
              className="seg-item"
              onClick={() => switchMode('login')}
            >
              Log in
            </button>
            <button
              type="button"
              role="tab"
              id="auth-tab-signup"
              aria-selected={tab === 'signup'}
              aria-controls="auth-panel"
              className="seg-item"
              onClick={() => switchMode('signup')}
            >
              Sign up
            </button>
          </div>

          {mode === 'forgot' ? (
            <ForgotForm email={email} onEmail={setEmail} onBack={() => switchMode('login')} />
          ) : (
            <form
              id="auth-panel"
              role="tabpanel"
              aria-labelledby={`auth-tab-${tab}`}
              className="stack"
              onSubmit={(e) => void onSubmit(e)}
            >
              {expired && !error && <Notice kind="info">Your session ended. Log in again to continue.</Notice>}
              <div className="field">
                <label htmlFor="auth-email">Email</label>
                <input
                  id="auth-email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="auth-password">Password</label>
                <input
                  id="auth-password"
                  type="password"
                  name="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={8}
                  maxLength={200}
                  aria-describedby={mode === 'signup' ? 'auth-password-hint' : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {mode === 'signup' && (
                  <p id="auth-password-hint" className="hint">
                    At least 8 characters.
                  </p>
                )}
              </div>
              {error && <Notice kind="error">{error}</Notice>}
              <Button type="submit" variant="primary" busy={busy} className="btn-block">
                {mode === 'login' ? 'Log in' : 'Create account'}
              </Button>
              {/* After the submit button, so Tab goes email, password, Log in. */}
              {mode === 'login' && (
                <button type="button" className="link-btn auth-alt" onClick={() => switchMode('forgot')}>
                  Forgot password?
                </button>
              )}
            </form>
          )}
        </section>
      </div>
    </main>
  );
}

interface ForgotFormProps {
  email: string;
  onEmail: (email: string) => void;
  onBack: () => void;
}

function ForgotForm({ email, onEmail, onBack }: ForgotFormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestReset({ email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div id="auth-panel" role="tabpanel" aria-labelledby="auth-tab-login" className="stack">
        {/* Worded the same whether or not the account exists: the server does not say. */}
        <Notice kind="success">If an account exists for that address, a reset link is on its way.</Notice>
        <p className="hint">The link expires in 60 minutes and works once. Check your spam folder if it does not arrive.</p>
        <button type="button" className="link-btn auth-alt" onClick={onBack}>
          Back to log in
        </button>
      </div>
    );
  }

  return (
    <form
      id="auth-panel"
      role="tabpanel"
      aria-labelledby="auth-tab-login"
      className="stack"
      onSubmit={(e) => void onSubmit(e)}
    >
      <p className="hint">Enter the email you signed up with and we will send a link to choose a new password.</p>
      <div className="field">
        <label htmlFor="forgot-email">Email</label>
        <input
          id="forgot-email"
          type="email"
          name="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          onChange={(e) => onEmail(e.target.value)}
        />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy} className="btn-block">
        Send reset link
      </Button>
      <button type="button" className="link-btn auth-alt" onClick={onBack}>
        Back to log in
      </button>
    </form>
  );
}
