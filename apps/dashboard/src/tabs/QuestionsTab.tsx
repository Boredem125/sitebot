import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { Lead, Site, UnansweredQuestion } from '@sitebot/shared';
import { addQa } from '../api';
import { listLeads, listUnanswered } from '../api-insights';
import { Button, EmptyState, ErrorState, Notice, Spinner } from '../components/ui';
import { errorMessage, formatNumber, formatRelative, isoDate } from '../lib/format';
import { useLoad } from '../lib/useLoad';

const ANSWER_MAX = 2000;
// The longest question the content API stores for a question-and-answer pair.
const QA_QUESTION_MAX = 300;

/** Questions the bot could not answer, and the emails visitors left. */
export function QuestionsTab({ site }: { site: Site }) {
  return (
    <div className="stack-lg">
      <UnansweredCard siteId={site.id} />
      <LeadsCard site={site} />
    </div>
  );
}

function UnansweredCard({ siteId }: { siteId: string }) {
  const { state, reload } = useLoad((signal) => listUnanswered(siteId, signal), siteId);

  return (
    <section className="card" aria-labelledby="unanswered-title">
      <h2 id="unanswered-title">Unanswered questions</h2>
      <p className="hint">
        What visitors asked that the bot could not answer from your content. Write an answer and the bot uses it
        from then on.
      </p>
      {state.status === 'loading' && <Spinner label="Loading questions" />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={reload} />}
      {state.status === 'ready' && state.data.length === 0 && <EmptyState title="No unanswered questions. Nice." />}
      {state.status === 'ready' && state.data.length > 0 && (
        <ul className="q-list">
          {state.data.map((item) => (
            <UnansweredRow key={`${item.lastAskedAt}-${item.question}`} siteId={siteId} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

type RowMode = 'idle' | 'editing' | 'saved';

function UnansweredRow({ siteId, item }: { siteId: string; item: UnansweredQuestion }) {
  const [mode, setMode] = useState<RowMode>('idle');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = answer.trim();
    if (!text) {
      setError('Write an answer first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addQa(siteId, { question: item.question.trim().slice(0, QA_QUESTION_MAX), answer: text });
      setMode('saved');
    } catch (err) {
      setError(`Could not save. ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="q-item">
      <div className="q-head">
        <div className="q-main">
          {/* Plain text on purpose: visitor input is never interpreted as HTML. */}
          <p className="q-text">{item.question}</p>
          <p className="hint">
            Asked {formatNumber(item.count)} {item.count === 1 ? 'time' : 'times'}
            {' · '}
            last asked <time dateTime={isoDate(item.lastAskedAt)}>{formatRelative(item.lastAskedAt)}</time>
          </p>
        </div>
        {mode === 'idle' && (
          <Button className="q-action" onClick={() => setMode('editing')}>
            Answer it
          </Button>
        )}
      </div>

      {mode === 'editing' && (
        <form className="q-form" onSubmit={(e) => void onSubmit(e)}>
          <div className="field">
            <div className="label-row">
              <label htmlFor={fieldId}>Answer</label>
              <span className="counter">
                {answer.length} / {ANSWER_MAX}
              </span>
            </div>
            <textarea
              id={fieldId}
              required
              autoFocus
              rows={4}
              maxLength={ANSWER_MAX}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={busy}>
              Save answer
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {mode === 'saved' && <Notice kind="success">Saved. The bot will use it in about a minute.</Notice>}
    </li>
  );
}

/** `mailto:` for an address from the API. Both halves are encoded, so it cannot add headers or recipients. */
function mailtoHref(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return `mailto:${encodeURIComponent(email.slice(0, at))}@${encodeURIComponent(email.slice(at + 1))}`;
}

function LeadsCard({ site }: { site: Site }) {
  const { state, reload } = useLoad((signal) => listLeads(site.id, signal), site.id);

  return (
    <section className="card" aria-labelledby="leads-title">
      <h2 id="leads-title">Contact requests</h2>
      <p className="hint">Visitors who left an email after a question the bot could not answer.</p>
      {state.status === 'loading' && <Spinner label="Loading contact requests" />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={reload} />}
      {state.status === 'ready' && state.data.length === 0 && (
        <EmptyState title="No contact requests yet">
          {site.leadCapture
            ? 'When a visitor leaves an email, it appears here.'
            : 'The bot is not asking for emails. You can turn that on under Appearance.'}
        </EmptyState>
      )}
      {state.status === 'ready' && state.data.length > 0 && (
        <ul className="q-list">
          {state.data.map((lead) => (
            <LeadRow key={lead.id} lead={lead} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LeadRow({ lead }: { lead: Lead }) {
  const href = mailtoHref(lead.email);
  return (
    <li className="q-item">
      <div className="q-head">
        <div className="q-main">
          <p className="q-text">{href ? <a href={href}>{lead.email}</a> : lead.email}</p>
          {lead.question ? <p className="q-quote">{lead.question}</p> : <p className="hint">No question recorded.</p>}
        </div>
        <time className="hint q-when" dateTime={isoDate(lead.createdAt)}>
          {formatRelative(lead.createdAt)}
        </time>
      </div>
    </li>
  );
}
