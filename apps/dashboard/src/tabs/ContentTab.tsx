import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { LIMITS } from '@sitebot/shared';
import type { Source, SourceKind, SourceStatus } from '@sitebot/shared';
import { addCrawl, addQa, listSources, uploadFile } from '../api';
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

  const onAdded = (source: Source): void => setData((prev) => [source, ...prev.filter((s) => s.id !== source.id)]);

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
              <SourceRow key={source.id} source={source} />
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

function SourceRow({ source }: { source: Source }) {
  const href = source.kind === 'crawl' ? safeHttpUrl(source.label) : null;
  const unit = source.kind === 'crawl' ? 'page' : 'document';
  return (
    <li className="source">
      <div className="source-main">
        <span className="kind">{KIND_LABELS[source.kind]}</span>
        {href ? (
          <a className="source-label" href={href} target="_blank" rel="noopener noreferrer">
            {source.label}
          </a>
        ) : (
          <span className="source-label">{source.label}</span>
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
