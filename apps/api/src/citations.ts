export interface CitationFilter {
  /** Feeds streamed text in; returns the part that is safe to show now. */
  push(text: string): string;
  /** Call once after the last push; returns whatever text was still held back. */
  end(): string;
  /** Passage numbers (1-based) the model cited so far. */
  cited: Set<number>;
}

/**
 * The model is asked to mark the context passages it used as `[1]`, `[2]`... This
 * strips those markers from the streamed answer and records them, so source links
 * are shown only for passages that actually backed the answer.
 *
 * Trailing whitespace and a half-received marker (`[`, `[1`) are held back until
 * the next piece arrives, because a marker can be split across stream chunks.
 * Numbers outside 1..max are left in the text: they are not ours.
 */
export function createCitationFilter(max: number): CitationFilter {
  const cited = new Set<number>();
  let held = '';

  const strip = (text: string): string =>
    text.replace(/\s*\[(\d{1,2})\]/g, (whole: string, digits: string) => {
      const n = Number(digits);
      if (n < 1 || n > max) return whole;
      cited.add(n);
      return '';
    });

  return {
    cited,
    push(text) {
      const clean = strip(held + text);
      const cut = clean.search(/\s*(?:\[\d{0,2})?$/);
      held = clean.slice(cut);
      return clean.slice(0, cut);
    },
    end() {
      const rest = strip(held).trimEnd();
      held = '';
      return rest;
    },
  };
}
