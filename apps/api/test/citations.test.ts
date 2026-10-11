import { describe, expect, it } from 'vitest';
import { createCitationFilter } from '../src/citations';

/** Feeds the pieces through a filter; returns what a visitor would see and what was cited. */
function run(pieces: string[], max = 5): { text: string; cited: number[] } {
  const filter = createCitationFilter(max);
  let text = '';
  for (const piece of pieces) text += filter.push(piece);
  text += filter.end();
  return { text, cited: [...filter.cited].sort((a, b) => a - b) };
}

describe('createCitationFilter', () => {
  it('strips trailing markers and records them', () => {
    expect(run(['Support is open 9 to 6. [2]'])).toEqual({ text: 'Support is open 9 to 6.', cited: [2] });
    expect(run(['Yes. [1][3]'])).toEqual({ text: 'Yes.', cited: [1, 3] });
    expect(run(['Yes. [1] [3]\n'])).toEqual({ text: 'Yes.', cited: [1, 3] });
  });

  it('strips a marker in the middle of a sentence without joining words', () => {
    expect(run(['Plans start at $10 [1] per month.'])).toEqual({
      text: 'Plans start at $10 per month.',
      cited: [1],
    });
  });

  it('handles a marker split across stream pieces at every position', () => {
    const full = 'Refunds take 14 days. [1][2]';
    for (let i = 1; i < full.length; i++) {
      expect(run([full.slice(0, i), full.slice(i)])).toEqual({ text: 'Refunds take 14 days.', cited: [1, 2] });
    }
    expect(run([...full])).toEqual({ text: 'Refunds take 14 days.', cited: [1, 2] });
  });

  it('never shows part of a marker before it is complete', () => {
    const filter = createCitationFilter(3);
    expect(filter.push('Done. ')).toBe('Done.');
    expect(filter.push('[')).toBe('');
    expect(filter.push('2')).toBe('');
    expect(filter.push(']')).toBe('');
    expect(filter.end()).toBe('');
    expect([...filter.cited]).toEqual([2]);
  });

  it('records nothing when the model cites nothing', () => {
    expect(run(["I don't know. Please contact the site."])).toEqual({
      text: "I don't know. Please contact the site.",
      cited: [],
    });
  });

  it('leaves numbers outside the passage range as text', () => {
    expect(run(['See item [9] and [0].'], 3)).toEqual({ text: 'See item [9] and [0].', cited: [] });
  });

  it('keeps inner whitespace and unrelated brackets', () => {
    expect(run(['Line one.\n', 'Line two [beta] costs 14'])).toEqual({
      text: 'Line one.\nLine two [beta] costs 14',
      cited: [],
    });
    expect(run(['Ends with an open bracket ['])).toEqual({ text: 'Ends with an open bracket [', cited: [] });
  });
});
