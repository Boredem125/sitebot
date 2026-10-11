import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { LIMITS } from '@sitebot/shared';
import type { Source, SourceKind, SourceStatus } from '@sitebot/shared';
import { ApiRequestError, addCrawl, addQa, deleteSource, listSources, recrawlSource, uploadFile } from '../api';
import { Button, EmptyState, ErrorState, Notice, Spinner } from '../components/ui';
import {
  errorMessage,
  formatBytes,
  formatNumber,
  formatRelative,
  isAbort,
  isoDate,
  normalizeUrl,
  safeHttpUrl,
} from '../lib/format';
import { useLoad } from '../lib/useLoad';

const POLL_MS = 4000;
const QUESTION_MAX = 300;
const ANSWER_MAX = 2000;

const KIND_LABELS: Record<SourceKind, string> = { crawl: 'Website', upload: 'File', qa: 'Q&A' };
const STATUS_LABELS: Record<SourceStatus, string> = {
  pending: 'Queued',
  processing: 'Indexing',
  ready: 'Ready',
  error: 'Failed',
};

const isActive = (source: Source): boolean => source.status === 'pending' || source.status === 'processing';

// Matches the API: a crawl that has made no progress for 15 minutes may be started again.
const STUCK_MS = 15 * 60_000;
const isStuck = (source: Source): boolean => isActive(source) && Date.now() - source.updatedAt > STUCK_MS;

export function ContentTab({ siteId }: { siteId: string }) {
  const { state, reload, setData } = useLoad((signal) => listSources(siteId, signal), siteId);
  const sources = state.status === 'ready' ? state.data : null;
  const active = sources !== null && sources.some(isActive);
  const [pollFailed, setPollFailed] = useState(false);
  // Bumped after a failed poll so the effect below schedules the next attempt.
  const [retry, setRetry] = useState(0);

  // One timeout per round rather than an interval: the next poll is only
  // scheduled once the previous response is in, so slow responses never stack.
  // Cleanup runs on unmount, which covers leaving the tab or the site.
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      listSources(siteId, ctrl.signal).then(
        (next) => {
          if (ctrl.signal.aborted) return;
          setPollFailed(false);
          setData(next);
        },
        (err: unknown) => {
          if (ctrl.signal.aborted || isAbort(err)) return;
          setPollFailed(true);
          setRetry((n) => n + 1);
        },
      );
    }, POLL_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [active, sources, retry, siteId, setData]);

  // A refresh started by a row outlives the row (a deleted row unmounts), so it is tied to the tab.
  const refreshCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => refreshCtrl.current?.abort(), []);

  // A refresh still in flight was read before these changes and would undo them, so it is dropped.
  const onAdded = (source: Source): void => {
    refreshCtrl.current?.abort();
    setData((prev) => [source, ...prev.filter((s) => s.id !== source.id)]);
  };

  // A re-crawl comes back 'pending', which makes the list active and starts the polling above.
  const onChanged = (source: Source): void => {
    refreshCtrl.current?.abort();
    setData((prev) => prev.map((s) => (s.id === source.id ? source : s)));
  };

  /** Re-reads the list in place, without the loading state a full reload would show. */
  const refresh = (): void => {
    refreshCtrl.current?.abort();
    const ctrl = new AbortController();
    refreshCtrl.current = ctrl;
    listSources(siteId, ctrl.signal).then(
      (next) => {
        if (!ctrl.signal.aborted) setData(next);
      },
      () => {
        // The row is already gone from the list; the next poll or visit corrects anything else.
      },
    );
  };

  const onDeleted = (sourceId: string): void => {
    setData((prev) => prev.filter((s) => s.id !== sourceId));
    refresh();
  };

  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="sources-title">
        <div className="card-head">
          <h2 id="sources-title">Sources</h2>
          {active && (
            <span className="live" role="status">
              <span className="spinner spinner-sm" aria-hidden="true" />
              {pollFailed ? 'Reconnecting…' : 'Indexing, updating automatically'}
            </span>
          )}
        </div>
        {state.status === 'loading' && <Spinner label="Loading sources" />}
        {state.status === 'error' && <ErrorState error={state.error} onRetry={reload} />}
        {sources !== null && sources.length === 0 && (
          <EmptyState title="No content yet">Add a website, a file, or a question and answer below.</EmptyState>
        )}
        {sources !== null && sources.length > 0 && (
          <ul className="source-list">
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                siteId={siteId}
                source={source}
                onChanged={onChanged}
                onDeleted={onDeleted}
                onStale={refresh}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="form-grid">
        <CrawlForm siteId={siteId} onAdded={onAdded} />
        <UploadForm siteId={siteId} onAdded={onAdded} />
        <QaForm siteId={siteId} onAdded={onAdded} />
      </div>
    </div>
  );
}

interface SourceRowProps {
  siteId: string;
  source: Source;
  onChanged: (source: Source) => void;
  onDeleted: (sourceId: string) => void;
  /** The row acted on out-of-date information: the list should be read again. */
  onStale: () => void;
}

function SourceRow({ siteId, source, onChanged, onDeleted, onStale }: SourceRowProps) {
  const href = source.kind === 'crawl' ? safeHttpUrl(source.label) : null;
  const unit = source.kind === 'crawl' ? 'page' : 'document';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'recrawl' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = `source-${source.id}`;

  async function onRecrawl(): Promise<void> {
    setBusy('recrawl');
    setError(null);
    try {
      onChanged(await recrawlSource(siteId, source.id));
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 409 || err.status === 404)) {
        // Someone else started it, or the source is gone. Either way the list here is old.
        onStale();
      }
      setError(
        err instanceof ApiRequestError && err.status === 409
          ? 'This source is already being indexed.'
          : `Could not start the re-crawl. ${errorMessage(err)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(): Promise<void> {
    setBusy('delete');
    setError(null);
    try {
      await deleteSource(siteId, source.id);
      // The row unmounts with the list update, so there is no state left to reset.
      onDeleted(source.id);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        // Already deleted elsewhere: the outcome the owner asked for.
        onDeleted(source.id);
        return;
      }
      setError(`Could not delete this source. ${errorMessage(err)}`);
      setBusy(null);
    }
  }

  return (
    <li className="source">
      <div className="source-head">
        <div className="source-main">
          <span className="kind">{KIND_LABELS[source.kind]}</span>
          {href ? (
            <a id={titleId} className="source-label" href={href} target="_blank" rel="noopener noreferrer">
              {source.label}
            </a>
          ) : (
            <span id={titleId} className="source-label">
              {source.label}
            </span>
          )}
        </div>
        {!confirming && (
          <div className="source-actions">
            {source.kind === 'crawl' && (
              <Button
                className="btn-sm"
                busy={busy === 'recrawl'}
                disabled={(isActive(source) && !isStuck(source)) || busy !== null}
                title={isActive(source) && !isStuck(source) ? 'This source is being indexed' : undefined}
                aria-describedby={titleId}
                onClick={() => void onRecrawl()}
              >
                Re-crawl
              </Button>
            )}
            <Button
              className="btn-sm btn-danger-quiet"
              disabled={busy !== null}
              aria-describedby={titleId}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              Delete
            </Button>
          </div>
        )}
      </div>
      <div className="source-meta">
        <span className={`badge badge-${source.status}`}>{STATUS_LABELS[source.status]}</span>
        <span>
          {formatNumber(source.pages)} {source.pages === 1 ? unit : `${unit}s`}
        </span>
        <span>
          Updated <time dateTime={isoDate(source.updatedAt)}>{formatRelative(source.updatedAt)}</time>
        </span>
      </div>
      {source.status === 'error' && (
        <p className="source-error">{source.error ?? 'This source could not be indexed.'}</p>
      )}
      {confirming && (
        <div className="confirm-row" role="group" aria-label={`Delete ${source.label}`}>
          <p>Delete this source? The bot stops using what it learned from it. This cannot be undone.</p>
          <div className="source-actions">
            <Button className="btn-sm btn-danger" busy={busy === 'delete'} onClick={() => void onDelete()}>
              Delete source
            </Button>
            {/* Focus lands on the safe choice, so a stray Enter does not delete anything. */}
            <Button className="btn-sm" autoFocus disabled={busy !== null} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </li>
  );
}

interface AddFormProps {
  siteId: string;
  onAdded: (source: Source) => void;
}

function CrawlForm({ siteId, onAdded }: AddFormProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError('Enter a valid web address, like https://example.com/docs.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onAdded(await addCrawl(siteId, { url: normalized }));
      setUrl('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void onSubmit(e)} aria-labelledby="crawl-title">
      <h3 id="crawl-title">Crawl a website</h3>
      <div className="field">
        <label htmlFor="crawl-url">Start URL</label>
        <input
          id="crawl-url"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={2000}
          placeholder="https://example.com/docs"
          aria-describedby="crawl-hint"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p id="crawl-hint" className="hint">
          Up to {LIMITS.crawlMaxPages} pages on the same site are read.
        </p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy}>
        Start crawl
      </Button>
    </form>
  );
}

function UploadForm({ siteId, onAdded }: AddFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const extensions: readonly string[] = LIMITS.uploadExtensions;

  function validate(candidate: File): string | null {
    const name = candidate.name.toLowerCase();
    if (!extensions.some((ext) => name.endsWith(ext))) {
      return `That file type is not supported. Upload ${extensions.join(', ')}.`;
    }
    if (candidate.size > LIMITS.uploadMaxBytes) {
      return `That file is ${formatBytes(candidate.size)}. The limit is ${formatBytes(LIMITS.uploadMaxBytes)}.`;
    }
    if (candidate.size === 0) return 'That file is empty.';
    return null;
  }

  function onPick(next: File | null): void {
    setFile(next);
    setError(next ? validate(next) : null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!file) return;
    const problem = validate(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onAdded(await uploadFile(siteId, file));
      setFile(null);
      if (input.current) input.current.value = '';
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void onSubmit(e)} aria-labelledby="upload-title">
      <h3 id="upload-title">Upload a file</h3>
      <div className="field">
        <label htmlFor="upload-file">File</label>
        <input
          ref={input}
          id="upload-file"
          type="file"
          required
          accept={extensions.join(',')}
          aria-describedby="upload-hint"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
        <p id="upload-hint" className="hint">
          PDF, TXT, or MD, up to {formatBytes(LIMITS.uploadMaxBytes)}.
        </p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy} disabled={!file || error !== null}>
        Upload
      </Button>
    </form>
  );
}

function QaForm({ siteId, onAdded }: AddFormProps) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const q = question.trim();
    const a = answer.trim();
    if (!q || !a) {
      setError('Enter both a question and an answer.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onAdded(await addQa(siteId, { question: q, answer: a }));
      setQuestion('');
      setAnswer('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void onSubmit(e)} aria-labelledby="qa-title">
      <h3 id="qa-title">Add a question and answer</h3>
      <div className="field">
        <div className="label-row">
          <label htmlFor="qa-question">Question</label>
          <span className="counter">
            {question.length} / {QUESTION_MAX}
          </span>
        </div>
        <input
          id="qa-question"
          type="text"
          required
          maxLength={QUESTION_MAX}
          placeholder="Do you ship internationally?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </div>
      <div className="field">
        <div className="label-row">
          <label htmlFor="qa-answer">Answer</label>
          <span className="counter">
            {answer.length} / {ANSWER_MAX}
          </span>
        </div>
        <textarea
          id="qa-answer"
          required
          rows={4}
          maxLength={ANSWER_MAX}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy}>
        Add answer
      </Button>
    </form>
  );
}
