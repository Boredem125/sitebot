// Renders the small subset of Markdown the assistant is allowed to use: paragraphs,
// bullet and numbered lists, **bold**, `code`, fenced code blocks, and links.
// It only ever creates elements and text nodes, so model output never reaches an
// HTML parser and cannot become markup.

const INLINE =
  /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`)\]]+)/g;

function link(label: string, href: string): Node {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return document.createTextNode(label);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return document.createTextNode(label);
  const a = document.createElement('a');
  a.textContent = label;
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  return a;
}

function inline(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    let length = m[0].length;
    if (at > last) parent.append(text.slice(last, at));
    if (m[1] !== undefined) {
      const strong = document.createElement('strong');
      strong.textContent = m[1];
      parent.append(strong);
    } else if (m[2] !== undefined) {
      const code = document.createElement('code');
      code.textContent = m[2];
      parent.append(code);
    } else if (m[3] !== undefined && m[4] !== undefined) {
      parent.append(link(m[3], m[4]));
    } else if (m[5] !== undefined) {
      // A bare URL at the end of a sentence: the full stop is not part of it.
      const url = m[5].replace(/[.,;:!?]+$/, '');
      length = url.length;
      parent.append(link(url, url));
    }
    last = at + length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function codeBlock(lines: string[]): HTMLElement {
  // Fences inside a list item arrive indented; drop the shared indent.
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99);
  const pre = document.createElement('pre');
  pre.textContent = lines.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length))).join('\n');
  return pre;
}

/** Replaces the content of `target` with the rendered form of `source`. */
export function renderMarkdown(target: HTMLElement, source: string): void {
  const out: HTMLElement[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flush = (): void => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    paragraph.forEach((line, i) => {
      if (i) p.append(document.createElement('br'));
      inline(p, line);
    });
    out.push(p);
    paragraph = [];
  };

  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const fence = /^\s*```/.test(raw);
    if (code) {
      if (fence) {
        out.push(codeBlock(code));
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
      const row = document.createElement('div');
      // A bullet indented under a numbered step stays visually under it.
      row.className = /^\s{2,}/.test(raw) ? 'li in' : 'li';
      const marker = document.createElement('span');
      marker.textContent = /\d/.test(item[1] ?? '') ? (item[1] ?? '').replace(')', '.') : '•';
      const body = document.createElement('span');
      inline(body, item[2] ?? '');
      row.append(marker, body);
      out.push(row);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      inline(strong, heading[1] ?? '');
      p.append(strong);
      out.push(p);
      continue;
    }
    paragraph.push(line);
  }
  // Still streaming: show an unclosed block as code rather than as stray backticks.
  if (code) out.push(codeBlock(code));
  flush();
  target.replaceChildren(...out);
}
