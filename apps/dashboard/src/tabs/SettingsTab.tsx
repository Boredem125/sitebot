import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Site } from '@sitebot/shared';
import { ApiRequestError, deleteSite } from '../api';
import { Button, Notice } from '../components/ui';
import { errorMessage } from '../lib/format';
import { navigate, sitesHref } from '../lib/route';

/** Site-level actions that do not fit elsewhere, such as deleting the site. */
export function SettingsTab({ site }: { site: Site }) {
  return (
    <div className="stack-lg">
      <DeleteSiteCard site={site} />
    </div>
  );
}

function DeleteSiteCard({ site }: { site: Site }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Names are stored trimmed; stray spaces around what was typed should not block the owner.
  const matches = typed.trim() === site.name;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSite(site.id);
      navigate(sitesHref);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        // Already deleted, from another tab or device: there is nothing left to show here.
        navigate(sitesHref);
        return;
      }
      setError(`Could not delete the site. ${errorMessage(err)}`);
      setBusy(false);
    }
  }

  return (
    <section className="card danger-card" aria-labelledby="delete-site-title">
      <h2 id="delete-site-title">Delete this site</h2>
      <p className="muted">
        This removes <strong>{site.name}</strong> for good. It cannot be undone.
      </p>
      <ul className="danger-list">
        <li>Everything the bot learned: crawled pages, uploaded files, and question and answer pairs.</li>
        <li>All conversations, the questions visitors asked, and any contact details they left.</li>
        <li>Usage history, the look you set up, and the install key.</li>
      </ul>
      <p className="hint">
        The widget stops working on every page that still has the install snippet, so remove the snippet from your
        site as well. Your account and your other sites are not affected.
      </p>
      <form className="stack danger-form" onSubmit={(e) => void onSubmit(e)}>
        <div className="field">
          <label htmlFor="delete-site-name">
            Type <span className="danger-name">{site.name}</span> to confirm
          </label>
          <input
            id="delete-site-name"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <Button type="submit" className="btn-danger" busy={busy} disabled={!matches}>
          Delete this site
        </Button>
      </form>
    </section>
  );
}
