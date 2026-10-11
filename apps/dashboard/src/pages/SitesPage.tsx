import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Site } from '@sitebot/shared';
import { createSite, listSites } from '../api';
import { Button, EmptyState, ErrorState, Notice, Spinner } from '../components/ui';
import { errorMessage, formatDate, isoDate, normalizeUrl } from '../lib/format';
import { siteHref } from '../lib/route';
import { useLoad } from '../lib/useLoad';

export function SitesPage({ onCreated }: { onCreated: (site: Site) => void }) {
  const { state, reload } = useLoad((signal) => listSites(signal), 'sites');

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Your sites</h1>
      </div>

      <section aria-label="Sites">
        {state.status === 'loading' && <Spinner label="Loading sites" />}
        {state.status === 'error' && <ErrorState error={state.error} onRetry={reload} />}
        {state.status === 'ready' && state.data.length === 0 && (
          <EmptyState title="No sites yet">Add your website below to create its bot.</EmptyState>
        )}
        {state.status === 'ready' && state.data.length > 0 && (
          <ul className="site-grid">
            {state.data.map((site) => (
              <li key={site.id}>
                <a className="card site-card" href={siteHref(site.id)}>
                  <span className="site-card-name">{site.name}</span>
                  <span className="muted site-card-domain">{site.domains[0] ?? 'No domain set'}</span>
                  <span className="hint">
                    Created <time dateTime={isoDate(site.createdAt)}>{formatDate(site.createdAt)}</time>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <NewSiteForm onCreated={onCreated} />
    </div>
  );
}

function NewSiteForm({ onCreated }: { onCreated: (site: Site) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError('Enter a valid website address, like https://example.com.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await createSite({ name: name.trim(), url: normalized }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="new-site-title">
      <h2 id="new-site-title">New site</h2>
      <p className="muted">We crawl the website you enter and use its pages to answer visitor questions.</p>
      <form className="form-row" onSubmit={(e) => void onSubmit(e)}>
        <div className="field">
          <label htmlFor="new-site-name">Name</label>
          <input
            id="new-site-name"
            type="text"
            required
            maxLength={80}
            placeholder="Acme Docs"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field field-grow">
          <label htmlFor="new-site-url">Website URL</label>
          <input
            id="new-site-url"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={2000}
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" busy={busy}>
          Create site
        </Button>
      </form>
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
