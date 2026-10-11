interface Unit {
  text: string;
  /** Separator that precedes this unit: a new paragraph or a continuation of one. */
  sep: '\n' | ' ';
}

/**
 * Splits text into chunks of at most `maxChars`, packing whole paragraphs where they fit.
 * Each chunk after the first is prefixed with the tail of the previous one, so a fact that
 * straddles a boundary is still retrievable. No chunk exceeds `maxChars + overlapChars`.
 */
export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? 2000));
  const overlapChars = Math.max(0, Math.floor(opts.overlapChars ?? 200));

  const units: Unit[] = [];
  for (const raw of text.split(/\n+/)) {
    const paragraph = raw.replace(/\s+/g, ' ').trim();
    if (paragraph === '') continue;
    if (paragraph.length <= maxChars) {
      units.push({ text: paragraph, sep: '\n' });
      continue;
    }
    let sep: Unit['sep'] = '\n';
    for (const piece of splitLong(paragraph, maxChars)) {
      units.push({ text: piece, sep });
      sep = ' ';
    }
  }

  // Greedy packing. `bodies` hold the chunks without their overlap prefix.
  const bodies: { text: string; sep: Unit['sep'] }[] = [];
  let current: { text: string; sep: Unit['sep'] } | null = null;
  for (const unit of units) {
    if (current && current.text.length + 1 + unit.text.length <= maxChars) {
      current.text += unit.sep + unit.text;
    } else {
      if (current) bodies.push(current);
      current = { text: unit.text, sep: unit.sep };
    }
  }
  if (current) bodies.push(current);

  return bodies.map((body, i) => {
    const prev = bodies[i - 1];
    if (!prev || overlapChars < 2) return body.text;
    // One character of the overlap budget goes to the separator.
    const tail = tailOf(prev.text, overlapChars - 1);
    return tail === '' ? body.text : tail + body.sep + body.text;
  });
}

/** Breaks an over-long paragraph into sentences, and over-long sentences into words. */
function splitLong(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (const sentence of paragraph.split(/(?<=[.!?]["')\]]?)\s+/)) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    for (const word of sentence.split(' ')) {
      // A single token longer than a chunk (a data URI, minified code) is cut blindly.
      for (let i = 0; i < word.length; i += maxChars) pieces.push(word.slice(i, i + maxChars));
    }
  }
  return pieces.filter((p) => p !== '');
}

/** Last `max` characters of `text`, moved forward to a word boundary when it lands mid-word. */
function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  if (/\s/.test(text.charAt(text.length - max - 1))) return tail.trimStart();
  const space = tail.search(/\s/);
  return space === -1 ? tail : tail.slice(space + 1).trimStart();
}
