import { normalizeUrl } from './url';

const SKIP_TAGS = new Set(['script', 'style', 'nav', 'noscript', 'svg', 'iframe', 'template', 'footer']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article',
  'blockquote', 'pre', 'td', 'th', 'dt', 'dd',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  // Not required for correctness, but common enough in prose that leaving them raw hurts answers.
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};

/** Decodes the common named entities and all numeric ones. One pass, so `&amp;lt;` stays `&lt;`. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Pulls the readable text, title, and outgoing links out of an HTML response.
 * `text` has one line per block-level element, so the chunker gets paragraph boundaries.
 */
export async function extractHtml(
  res: Response,
  baseUrl: string,
): Promise<{ title: string; text: string; links: string[] }> {
  let skipDepth = 0;
  let preDepth = 0;
  let inTitle = false;
  let titleSeen = false;
  let title = '';
  let body = '';
  // Raw text of the current text node. HTMLRewriter delivers it in arbitrary pieces that can
  // cut an entity in half, so decoding waits until the node is complete.
  let node = '';
  const links = new Set<string>();

  const flush = (): void => {
    if (node === '') return;
    const decoded = decodeEntities(node);
    node = '';
    if (inTitle) title += decoded;
    // Source line breaks are layout, not paragraphs, except inside <pre>.
    else body += preDepth > 0 ? decoded : decoded.replace(/\s+/g, ' ');
  };

  // A text handler on an element selector also receives descendant text (see the extract
  // tests), but text outside any element would be missed, so text is handled at document level
  // and the element handler only tracks where we are.
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') {
          // Links count even inside <nav> and <footer>: that is where most of a site's are.
          const href = el.getAttribute('href');
          // Attribute values arrive raw too: `?a=1&amp;b=2` must become `?a=1&b=2`.
          const url = href === null ? null : normalizeUrl(decodeEntities(href).trim(), baseUrl);
          if (url) links.add(url);
          return;
        }
        if (SKIP_TAGS.has(tag)) {
          // onEndTag throws for elements with no end tag (`<svg/>`); those enclose no text.
          try {
            el.onEndTag(() => {
              skipDepth--;
            });
            skipDepth++;
          } catch {
            // nothing to skip
          }
          return;
        }
        if (skipDepth > 0) return;
        if (tag === 'title' && !titleSeen) {
          titleSeen = true;
          try {
            el.onEndTag(() => {
              inTitle = false;
            });
            inTitle = true;
          } catch {
            // empty self-closed title
          }
          return;
        }
        if (BLOCK_TAGS.has(tag)) {
          body += '\n';
          try {
            el.onEndTag(() => {
              // Also break after the block, or `<h1>Title</h1>text` would read "Titletext".
              body += '\n';
              if (tag === 'pre') preDepth--;
            });
            if (tag === 'pre') preDepth++;
          } catch {
            // void element such as <br>
          }
        }
      },
    })
    .onDocument({
      text(chunk) {
        if (skipDepth > 0) return;
        node += chunk.text;
        if (chunk.lastInTextNode) flush();
      },
    });

  await rewriter.transform(res).arrayBuffer();
  flush();

  const text = body
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
  return { title: title.replace(/\s+/g, ' ').trim(), text, links: [...links] };
}
