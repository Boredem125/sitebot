import type { SiteUsage } from '@sitebot/shared';
import { getSite } from '../api';
import { ErrorState, Spinner } from '../components/ui';
import { formatMonth, formatNumber } from '../lib/format';
import { useLoad } from '../lib/useLoad';

const WARN_AT = 0.8;

export function UsageTab({ siteId }: { siteId: string }) {
  // Fetched when the tab opens rather than reused from the page load, so the
  // numbers are current even if the page has been open for a while.
  const { state, reload } = useLoad(async (signal) => (await getSite(siteId, signal)).usage, siteId);

  if (state.status === 'loading') return <Spinner label="Loading usage" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;
  return <UsageView usage={state.data} />;
}

function UsageView({ usage }: { usage: SiteUsage }) {
  const cap = Math.max(0, usage.cap);
  const used = Math.max(0, usage.messages);
  const ratio = cap > 0 ? used / cap : used > 0 ? 1 : 0;
  const percent = Math.min(100, Math.round(ratio * 100));
  const level = ratio >= 1 ? 'full' : ratio >= WARN_AT ? 'warn' : 'ok';
  const summary = `${formatNumber(used)} of ${formatNumber(cap)} messages`;

  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="usage-title">
        <div className="card-head">
          <h2 id="usage-title">Messages this month</h2>
          <span className="hint">{formatMonth(usage.month)} (UTC)</span>
        </div>
        <p className="usage-figure">
          {summary} <span className="muted">({percent}%)</span>
        </p>
        <div
          className={`meter meter-${level}`}
          role="progressbar"
          aria-labelledby="usage-title"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={Math.min(used, cap)}
          aria-valuetext={summary}
        >
          <div className="meter-fill" style={{ width: `${percent}%` }} />
        </div>
        {level === 'warn' && (
          <p className="notice notice-warn" role="status">
            You have used {percent}% of this month's messages. The bot stops answering when the cap is reached.
          </p>
        )}
        {level === 'full' && (
          <p className="notice notice-error" role="status">
            The monthly cap has been reached. The bot will not answer new messages until next month.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="tokens-title">
        <h2 id="tokens-title">Tokens this month</h2>
        <dl className="stats">
          <div className="stat">
            <dt>Prompt</dt>
            <dd>{formatNumber(usage.promptTokens)}</dd>
          </div>
          <div className="stat">
            <dt>Completion</dt>
            <dd>{formatNumber(usage.completionTokens)}</dd>
          </div>
          <div className="stat">
            <dt>Cached</dt>
            <dd>{formatNumber(usage.cachedTokens)}</dd>
          </div>
        </dl>
        <p className="hint">Cached tokens are the part of the prompt tokens served from the model's prompt cache.</p>
      </section>
    </div>
  );
}
