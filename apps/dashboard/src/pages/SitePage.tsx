import { useEffect, useRef } from 'react';
import type { Site } from '@sitebot/shared';
import { ApiRequestError, getSite } from '../api';
import { ErrorState, Spinner } from '../components/ui';
import { SITE_TABS, siteHref, sitesHref } from '../lib/route';
import type { SiteTab } from '../lib/route';
import { useLoad } from '../lib/useLoad';
import { AppearanceTab } from '../tabs/AppearanceTab';
import { ContentTab } from '../tabs/ContentTab';
import { ConversationsTab } from '../tabs/ConversationsTab';
import { InstallTab } from '../tabs/InstallTab';
import { UsageTab } from '../tabs/UsageTab';

const TAB_LABELS: Record<SiteTab, string> = {
  install: 'Install',
  content: 'Content',
  appearance: 'Appearance',
  conversations: 'Conversations',
  usage: 'Usage',
};

export function SitePage({ siteId, tab }: { siteId: string; tab: SiteTab }) {
  const { state, reload, setData } = useLoad((signal) => getSite(siteId, signal), siteId);
  const nav = useRef<HTMLElement>(null);
  const ready = state.status === 'ready';

  // The tab strip scrolls sideways on phones, so the current tab could start
  // off-screen when the page is opened from a deep link.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab, ready]);

  if (state.status === 'loading') return <Spinner label="Loading site" />;
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) {
      return (
        <div className="state state-empty">
          <p className="state-title">Site not found</p>
          <p>
            <a href={sitesHref}>Back to your sites</a>
          </p>
        </div>
      );
    }
    return <ErrorState error={state.error} onRetry={reload} />;
  }

  const { site } = state.data;
  const onSiteChange = (next: Site): void => setData((prev) => ({ ...prev, site: next }));

  return (
    <div className="stack-lg">
      <div className="page-head">
        <a className="back-link" href={sitesHref}>
          <span aria-hidden="true">←</span> All sites
        </a>
        <h1>{site.name}</h1>
      </div>

      <nav ref={nav} className="tabs" aria-label="Site sections">
        {SITE_TABS.map((t) => (
          <a key={t} className="tab" href={siteHref(site.id, t)} aria-current={t === tab ? 'page' : undefined}>
            {TAB_LABELS[t]}
          </a>
        ))}
      </nav>

      {/* Each tab mounts fresh, so its timers and requests end when you leave it. */}
      {tab === 'install' && <InstallTab site={site} />}
      {tab === 'content' && <ContentTab siteId={site.id} />}
      {tab === 'appearance' && <AppearanceTab site={site} onSaved={onSiteChange} />}
      {tab === 'conversations' && <ConversationsTab siteId={site.id} />}
      {tab === 'usage' && <UsageTab siteId={site.id} />}
    </div>
  );
}
