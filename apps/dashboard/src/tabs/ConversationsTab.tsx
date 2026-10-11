import { useState } from 'react';
import type { ConversationSummary, Message, SourceLink } from '@sitebot/shared';
import { getMessages, listConversations } from '../api';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { formatDateTime, formatNumber, formatRelative, isoDate, safeHttpUrl } from '../lib/format';
import { useLoad } from '../lib/useLoad';

export function ConversationsTab({ siteId }: { siteId: string }) {
  const { state, reload } = useLoad((signal) => listConversations(siteId, signal), siteId);
  const [selected, setSelected] = useState<string | null>(null);

  if (state.status === 'loading') return <Spinner label="Loading conversations" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;
  if (state.data.length === 0) {
    return (
      <div className="card">
        <EmptyState title="No conversations yet">
          When visitors chat with the bot on your site, their conversations appear here.
        </EmptyState>
      </div>
    );
  }

  const current = state.data.find((c) => c.id === selected) ?? null;

  return (
    // On narrow screens only one pane shows at a time; `has-selection` flips which.
    <div className={`convo card${current ? ' has-selection' : ''}`}>
      <nav className="convo-list" aria-label="Conversations">
        <ul>
          {state.data.map((conversation) => (
            <li key={conversation.id}>
              <ConversationItem
                conversation={conversation}
                selected={conversation.id === selected}
                onSelect={() => setSelected(conversation.id)}
              />
            </li>
          ))}
        </ul>
      </nav>
      <section className="convo-thread" aria-label="Messages">
        {current ? (
          <>
            <div className="convo-thread-head">
              <button type="button" className="btn btn-ghost convo-back" onClick={() => setSelected(null)}>
                <span aria-hidden="true">←</span> Conversations
              </button>
              <span className="hint">
                Started <time dateTime={isoDate(current.createdAt)}>{formatDateTime(current.createdAt)}</time>
              </span>
            </div>
            <Thread key={current.id} siteId={siteId} conversationId={current.id} />
          </>
        ) : (
          <EmptyState title="Select a conversation">Pick one from the list to read it.</EmptyState>
        )}
      </section>
    </div>
  );
}

function ConversationItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="convo-item" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <span className="convo-preview">{conversation.preview || 'No visitor message'}</span>
      <span className="hint">
        {formatNumber(conversation.messageCount)} {conversation.messageCount === 1 ? 'message' : 'messages'}
        {' · '}
        <time dateTime={isoDate(conversation.updatedAt)}>{formatRelative(conversation.updatedAt)}</time>
      </span>
    </button>
  );
}

function Thread({ siteId, conversationId }: { siteId: string; conversationId: string }) {
  const { state, reload } = useLoad(
    (signal) => getMessages(siteId, conversationId, signal),
    `${siteId}/${conversationId}`,
  );

  if (state.status === 'loading') return <Spinner label="Loading messages" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;
  if (state.data.length === 0) return <EmptyState title="This conversation has no messages" />;

  return (
    <ol className="messages">
      {state.data.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </ol>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isBot = message.role === 'assistant';
  return (
    <li className={`msg ${isBot ? 'msg-bot' : 'msg-user'}`}>
      <span className="msg-who">
        {isBot ? 'Bot' : 'Visitor'}
        {' · '}
        <time dateTime={isoDate(message.createdAt)}>{formatDateTime(message.createdAt)}</time>
      </span>
      {/* Plain text on purpose: visitor and model output is never interpreted as HTML. */}
      <p className="msg-bubble">{message.content}</p>
      {isBot && message.sources.length > 0 && <Sources sources={message.sources} />}
    </li>
  );
}

function Sources({ sources }: { sources: SourceLink[] }) {
  return (
    <ul className="msg-sources" aria-label="Sources">
      {sources.map((source, i) => {
        const href = safeHttpUrl(source.url);
        const text = source.title.trim() || source.url;
        return (
          <li key={`${i}-${source.url}`}>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {text}
              </a>
            ) : (
              // Not an http(s) URL, so it is shown but never made clickable.
              <span>{text}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
