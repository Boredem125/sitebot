import { describe, expect, it } from 'vitest';
import { decodeEntities, extractHtml } from '../src/ingest/extract';

const BASE = 'https://example.com/docs/page';

const page = (html: string): Response =>
  new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

/** Response whose body arrives in the given pieces, as separate network reads. */
function streamed(parts: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/html' } });
}

describe('HTMLRewriter behaviour this module relies on', () => {
  it('gives an element-selector text handler descendant text too, raw and in pieces', async () => {
    const seen: string[] = [];
    await new HTMLRewriter()
      .on('div', {
        text(chunk) {
          seen.push(chunk.text);
        },
      })
      .transform(page('<div>direct <b>nested <i>deep</i></b> a &amp; b</div> outside'))
      .text();
    // Descendant text is included, entities are not decoded, and text outside the element is
    // not seen: hence document-level text handling plus our own decoding in extractHtml.
    expect(seen.join('')).toBe('direct nested deep a &amp; b');
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities in one pass', () => {
    expect(decodeEntities('&amp; &lt; &gt; &quot; &#39; &apos; &#65; &#x42; &#X43;')).toBe(
      '& < > " \' \' A B C',
    );
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&unknown; &#0; AT&T')).toBe('&unknown; � AT&T');
  });
});

describe('extractHtml', () => {
  it('drops text inside script, style, nav, footer and the other skipped elements', async () => {
    const { text } = await extractHtml(
      page(`<html><head><title>T</title><style>body { color: red }</style>
        <script>var hidden = "SCRIPT";</script></head>
        <body>
          <nav><ul><li><a href="/">NAVTEXT</a></li></ul></nav>
          <p>Visible one.</p>
          <noscript>NOSCRIPT</noscript>
          <svg><title>SVGTITLE</title><text>SVGTEXT</text></svg>
          <iframe>IFRAME</iframe>
          <template><p>TEMPLATE</p></template>
          <p>Visible two.</p>
          <footer><div><p>FOOTER <span>DEEP</span></p></div></footer>
          <script type="application/ld+json">{"x":"JSONLD"}</script>
        </body></html>`),
      BASE,
    );
    expect(text).toBe('Visible one.\nVisible two.');
  });

  it('keeps text of nested elements in order, on one line per block', async () => {
    const { text } = await extractHtml(
      page(`<body><div>Hello <b>bold <i>deep</i></b> world</div>
        <h1>Heading</h1>trailing text
        <ul><li>One</li><li>Two <a href="/x">link</a></li></ul>
        <table><tr><td>A</td><td>B</td></tr></table>
        <p>Line one<br>line two</p></body>`),
      BASE,
    );
    expect(text.split('\n')).toEqual([
      'Hello bold deep world',
      'Heading',
      'trailing text',
      'One',
      'Two link',
      'A',
      'B',
      'Line one',
      'line two',
    ]);
  });

  it('resumes after a skipped element, including nested and self-closed ones', async () => {
    const { text } = await extractHtml(
      page(`<p>before</p><footer>F1<nav>N<div>deep</div></nav>F2</footer><p>middle</p>
        <svg/><p>after svg</p><nav><nav>inner</nav>still nav</nav>end`),
      BASE,
    );
    expect(text).toBe('before\nmiddle\nafter svg\nend');
  });

  it('treats source line breaks as spaces and collapses whitespace', async () => {
    const { text } = await extractHtml(page('<p>  Hello\n     there,\t\tworld  </p>\n\n<p>\n</p><p>Next</p>'), BASE);
    expect(text).toBe('Hello there, world\nNext');
  });

  it('decodes entities', async () => {
    const { text } = await extractHtml(
      page('<p>Fish &amp; chips &lt;b&gt; &quot;q&quot; &#39;s&#39; &apos;a&apos; x&nbsp;y &#8364;5 &#x1F600;</p>'),
      BASE,
    );
    expect(text).toBe('Fish & chips <b> "q" \'s\' \'a\' x y €5 \u{1F600}');
  });

  it('decodes an entity that is split across network chunks', async () => {
    const { text, title } = await extractHtml(
      streamed(['<title>A &am', 'p; B</title><p>Fish &am', 'p; chips &#x26', '; peas &#3', '8; more</p>']),
      BASE,
    );
    expect(title).toBe('A & B');
    expect(text).toBe('Fish & chips & peas & more');
  });

  it('reads and trims the title, ignoring titles inside svg', async () => {
    const { title, text } = await extractHtml(
      page(`<html><head><title>
          Pricing &amp; Plans
        </title></head><body><svg><title>Icon</title></svg><p>Body</p></body></html>`),
      BASE,
    );
    expect(title).toBe('Pricing & Plans');
    expect(text).toBe('Body');
  });

  it('returns an empty title and text for a page without them', async () => {
    expect(await extractHtml(page('<html><body><script>1</script></body></html>'), BASE)).toEqual({
      title: '',
      text: '',
      links: [],
    });
  });

  it('resolves links against the base URL, drops unusable ones, and de-duplicates', async () => {
    const { links } = await extractHtml(
      page(`<nav><a href="/">Home</a></nav>
        <a href="/pricing">Pricing</a>
        <a href="/pricing#plans">Plans</a>
        <a href="guide?a=1&amp;b=2">Guide</a>
        <a href="../about">About</a>
        <a href="https://other.com/x">Other</a>
        <a href="mailto:hi@example.com">Mail</a>
        <a href="javascript:void(0)">JS</a>
        <a href="tel:+123">Tel</a>
        <a>No href</a>
        <a href="https://example.com/pricing">Again</a>
        <footer><a href="/terms">Terms</a></footer>`),
      BASE,
    );
    expect(links).toEqual([
      'https://example.com/',
      'https://example.com/pricing',
      'https://example.com/docs/guide?a=1&b=2',
      'https://example.com/about',
      'https://other.com/x',
      'https://example.com/terms',
    ]);
  });
});
