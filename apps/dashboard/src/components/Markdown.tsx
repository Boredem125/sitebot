import { Fragment, useMemo } from 'react';
import type { ReactNode } from 'react';
import { safeHttpUrl } from '../lib/format';

// The same small subset the widget renders (packages/widget/src/md.ts): paragraphs,
// bullet and numbered rows, **bold**, `code`, fenced code blocks, and links.
// Everything becomes a React element or a string, so model output is never parsed as HTML.

const INLINE =
  /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`)\]]+)/g;

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'item'; marker: string; text: string; nested: boolean }
  | { kind: 'code'; text: string };

function link(label: string, href: string, key: number): ReactNode {
  const url = safeHttpUrl(href);
  // Anything that is not http(s) stays text.
  if (!url) return label;
  return (
    <a key={key} href={url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    let length = m[0].length;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) {
      out.push(<strong key={at}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      out.push(<code key={at}>{m[2]}</code>);
    } else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(link(m[3], m[4], at));
    } else if (m[5] !== undefined) {
      // A bare URL at the end of a sentence: the full stop is not part of it.
      const url = m[5].replace(/[.,;:!?]+$/, '');
      length = url.length;
      out.push(link(url, url, at));
    }
    last = at + length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

function codeText(lines: string[]): string {
  // Fences inside a list item arrive indented; drop the shared indent.
  const indent = Math.min(...lines.filter((l) => l.trim()).map(indentOf), 99);
  return lines.map((l) => l.slice(Math.min(indent, indentOf(l)))).join('\n');
}

function parse(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = [];
  };

  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const fence = /^\s*```/.test(raw);
    if (code) {
      if (fence) {
        blocks.push({ kind: 'code', text: codeText(code) });
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (fence) {
      flush();
      code = [];
      continue;
    }
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const item = /^(\d+[.)]|[-*•])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const marker = item[1] ?? '';
      blocks.push({
        kind: 'item',
        marker: /\d/.test(marker) ? marker.replace(')', '.') : '•',
        text: item[2] ?? '',
        // A bullet indented under a numbered step stays visually under it.
        nested: /^\s{2,}/.test(raw),
      });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', text: heading[1] ?? '' });
      continue;
    }
    paragraph.push(line);
  }
  // A block the model never closed is still code, not stray backticks.
  if (code) blocks.push({ kind: 'code', text: codeText(code) });
  flush();
  return blocks;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p key={key}>
          {block.lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {inline(line)}
            </Fragment>
          ))}
        </p>
      );
    case 'heading':
      return (
        <p key={key}>
          <strong>{inline(block.text)}</strong>
        </p>
      );
    case 'item':
      return (
        <div key={key} className={block.nested ? 'md-li md-in' : 'md-li'}>
          <span>{block.marker}</span>
          <span>{inline(block.text)}</span>
        </div>
      );
    case 'code':
      return <pre key={key}>{block.text}</pre>;
  }
}

/** Renders an assistant answer. Wrap it in an element with the `md` class for the layout. */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parse(source), [source]);
  return <>{blocks.map(renderBlock)}</>;
}
