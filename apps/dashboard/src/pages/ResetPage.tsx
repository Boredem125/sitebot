import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiRequestError, confirmReset } from '../api';
import { Button, Notice } from '../components/ui';
import { errorMessage } from '../lib/format';
import { sitesHref } from '../lib/route';

const MIN_PASSWORD = 8;

/**
 * The page behind the link in a password reset mail. The token only ever travels in the
 * request body: it is not logged, stored, or put in any other URL.
 */
export function ResetPage({ token, onReset }: { token: string; onReset: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server refuses the link itself, as opposed to the password typed here.
  const [deadLink, setDeadLink] = useState(false);
  const [done, setDone] = useState(false);

  const mismatch = confirm !== '' && confirm !== password;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await confirmReset({ token, password });
      setDone(true);
      onReset();
    } catch (err) {
      // The password was checked above, so a 400 can only be about the link.
      setDeadLink(err instanceof ApiRequestError && err.status === 400);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center-screen">
      <div className="auth">
        <h1 className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true" />
          Sitebot
        </h1>
        <p className="muted auth-tagline">Choose a new password for your account.</p>

        <section className="card auth-card" aria-labelledby="reset-title">
          <h2 id="reset-title">Reset password</h2>
          {done ? (
            <div className="stack">
              <Notice kind="success">
                Password changed. <a href={sitesHref}>Log in.</a>
              </Notice>
              <p className="hint">Every device that was signed in to this account has been signed out.</p>
            </div>
          ) : (
            <form className="stack" onSubmit={(e) => void onSubmit(e)}>
              <div className="field">
                <label htmlFor="reset-password">New password</label>
                <input
                  id="reset-password"
                  type="password"
                  name="new-password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  maxLength={200}
                  aria-describedby="reset-password-hint"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                />
                <p id="reset-password-hint" className="hint">
                  At least {MIN_PASSWORD} characters.
                </p>
              </div>
              <div className="field">
                <label htmlFor="reset-confirm">Confirm new password</label>
                <input
                  id="reset-confirm"
                  type="password"
                  name="confirm-password"
                  autoComplete="new-password"
                  required
                  maxLength={200}
                  aria-invalid={mismatch || undefined}
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setError(null);
                  }}
                />
              </div>
              {error && <Notice kind="error">{error}</Notice>}
              {deadLink && (
                <p className="hint">
                  Reset links work once and expire after 60 minutes. <a href={sitesHref}>Go to log in</a> and choose
                  “Forgot password?” to get a new one.
                </p>
              )}
              <Button type="submit" variant="primary" busy={busy} className="btn-block">
                Change password
              </Button>
              <p className="hint auth-alt">
                <a href={sitesHref}>Back to log in</a>
              </p>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
