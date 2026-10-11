import { useEffect, useRef, useState } from 'react';
import type { Site } from '@sitebot/shared';
import { Button, Notice } from '../components/ui';

// The key is shown as text here, but the owner pastes this into their own HTML,
// so it must not be able to break out of the attribute.
const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type CopyState = 'idle' | 'copied' | 'unavailable';

export function InstallTab({ site }: { site: Site }) {
  const snippet = `<script src="${location.origin}/widget.js" data-site="${escapeAttr(site.publicKey)}" async></script>`;
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onCopy(): Promise<void> {
    window.clearTimeout(timer.current);
    try {
      // Undefined on insecure origins and in some embedded browsers.
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(snippet);
      setCopy('copied');
      timer.current = window.setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('unavailable');
    }
  }

  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="install-title">
        <h2 id="install-title">Add the bot to your website</h2>
        <p className="muted">
          Paste this tag just before the closing <code>&lt;/body&gt;</code> tag on every page where the bot should
          appear.
        </p>
        <div className="snippet">
          <pre tabIndex={0} aria-label="Install snippet">
            <code>{snippet}</code>
          </pre>
          <Button variant="primary" onClick={() => void onCopy()}>
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <span className="sr-only" role="status">
          {copy === 'copied' ? 'Snippet copied to clipboard' : ''}
        </span>
        {copy === 'unavailable' && (
          <Notice kind="info">
            Your browser blocked clipboard access. Click the snippet to select it, then copy it with Ctrl+C or ⌘C.
          </Notice>
        )}
      </section>

      <section className="card" aria-labelledby="domains-title">
        <h2 id="domains-title">Allowed domains</h2>
        <p className="muted">
          The widget only works on these domains and their subdomains. On any other site it will not load answers.
        </p>
        {site.domains.length === 0 ? (
          <Notice kind="error">No domains are allowed yet, so the widget will not work anywhere.</Notice>
        ) : (
          <ul className="chips">
            {site.domains.map((domain) => (
              <li key={domain} className="chip">
                {domain}
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          Change this list under <a href={`#/sites/${encodeURIComponent(site.id)}/appearance`}>Appearance</a>.
        </p>
      </section>
    </div>
  );
}
