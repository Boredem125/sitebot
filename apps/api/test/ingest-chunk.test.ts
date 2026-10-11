import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/ingest/chunk';

const sentence = (i: number): string => `Sentence number ${i} talks about topic ${i} in plain words.`;

/** Longest prefix of `next` that is also a suffix of `prev`. */
function sharedOverlap(prev: string, next: string): string {
  for (let n = Math.min(prev.length, next.length); n > 0; n--) {
    if (prev.endsWith(next.slice(0, n))) return next.slice(0, n);
  }
  return '';
}

describe('chunkText', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n \t \r\n ')).toEqual([]);
  });

  it('keeps a short text as one chunk and tidies whitespace', () => {
    expect(chunkText('  Hello   world.\n\n\nSecond   paragraph.  ')).toEqual([
      'Hello world.\nSecond paragraph.',
    ]);
  });

  it('packs paragraphs up to maxChars and never exceeds maxChars + overlapChars', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `${sentence(i)} ${sentence(i + 100)}`);
    const chunks = chunkText(paragraphs.join('\n\n'), { maxChars: 500, overlapChars: 80 });

    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(580);
    // Packing is real: a typical chunk holds several ~115-char paragraphs.
    expect(chunks[0]!.split('\n').length).toBeGreaterThanOrEqual(3);
    // Every paragraph survives whole in at least one chunk.
    for (const p of paragraphs) expect(chunks.some((c) => c.includes(p))).toBe(true);
  });

  it('uses the documented defaults', () => {
    const text = Array.from({ length: 200 }, (_, i) => sentence(i)).join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2200);
    expect(chunks[0]!.length).toBeGreaterThan(1800);
    expect(chunks[0]!.length).toBeLessThanOrEqual(2000);
  });

  it('starts each later chunk with the tail of the previous one, cut at a word boundary', () => {
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join('\n');
    const chunks = chunkText(text, { maxChars: 400, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(3);

    for (let i = 1; i < chunks.length; i++) {
      const overlap = sharedOverlap(chunks[i - 1]!, chunks[i]!);
      expect(overlap.length).toBeGreaterThan(20);
      expect(overlap.length).toBeLessThanOrEqual(60);
      // The overlap begins with a whole word of the previous chunk, not the middle of one.
      const before = chunks[i - 1]!.charAt(chunks[i - 1]!.length - overlap.length - 1);
      expect(before).toMatch(/\s/);
    }
  });

  it('adds no overlap when overlapChars is 0, and loses no text', () => {
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join('\n');
    const chunks = chunkText(text, { maxChars: 400, overlapChars: 0 });
    expect(chunks.join('\n')).toBe(text);
  });

  it('splits an over-long paragraph at sentence ends', () => {
    const paragraph = Array.from({ length: 80 }, (_, i) => sentence(i)).join(' ');
    expect(paragraph).not.toContain('\n');
    const chunks = chunkText(paragraph, { maxChars: 300, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect(chunk.startsWith('Sentence number')).toBe(true);
      expect(chunk.endsWith('.')).toBe(true);
    }
    expect(chunks.join(' ')).toBe(paragraph);
  });

  it('falls back to word boundaries when a sentence is too long', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const chunks = chunkText(words.join(' '), { maxChars: 120, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    // No word was cut in half.
    expect(chunks.join(' ').split(' ')).toEqual(words);
  });

  it('cuts a single token that is longer than a chunk', () => {
    const chunks = chunkText('x'.repeat(1000), { maxChars: 300, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(350);
  });
});
