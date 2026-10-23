import { describe, expect, it } from 'vitest';
import { chunkText, splitSections } from '../src/ingest/chunker.js';

const words = (n: number, word = 'lorem') => Array.from({ length: n }, () => word).join(' ');

describe('chunkText', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkText('', { size: 100, overlap: 10 })).toEqual([]);
    expect(chunkText('  \n\n \n', { size: 100, overlap: 10 })).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    expect(chunkText('Hello there.\n\nGeneral Kenobi.', { size: 100, overlap: 10 })).toEqual([
      'Hello there.\n\nGeneral Kenobi.',
    ]);
  });

  it('never exceeds the chunk size', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${words(20)}`).join('\n\n');
    const chunks = chunkText(text, { size: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(300);
  });

  it('repeats trailing context at the start of the next chunk', () => {
    const paragraphs = ['Alpha ' + words(10), 'Beta ' + words(10), 'Gamma ' + words(10)];
    const chunks = chunkText(paragraphs.join('\n\n'), { size: 140, overlap: 70 });
    expect(chunks).toEqual([
      `${paragraphs[0]}\n\n${paragraphs[1]}`,
      `${paragraphs[1]}\n\n${paragraphs[2]}`,
    ]);
  });

  it('splits an oversized paragraph by sentence, then by word', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence ${i} ${words(8)}.`);
    const chunks = chunkText(sentences.join(' '), { size: 120, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks[0]!.startsWith('Sentence 0')).toBe(true);

    const oneLongToken = 'x'.repeat(250);
    expect(chunkText(oneLongToken, { size: 100, overlap: 20 }).every((c) => c.length <= 100)).toBe(
      true,
    );
  });

  it('does not let a chunk span two markdown sections', () => {
    const chunks = chunkText('# Install\nRun npm install.\n\n# Usage\nRun hearthy ask.', {
      size: 1000,
      overlap: 0,
    });
    expect(chunks).toEqual(['# Install\nRun npm install.', '# Usage\nRun hearthy ask.']);
  });

  it('normalises Windows line endings', () => {
    expect(chunkText('one\r\n\r\ntwo', { size: 1000, overlap: 0 })).toEqual(['one\n\ntwo']);
  });

  it('rejects overlap that is not smaller than size', () => {
    expect(() => chunkText('text', { size: 10, overlap: 10 })).toThrow(RangeError);
  });
});

describe('splitSections', () => {
  it('ignores # lines inside fenced code blocks', () => {
    const md = '# Setup\n```bash\n# install deps\nnpm install\n```\n\n## Next\nDone.';
    expect(splitSections(md)).toEqual([
      '# Setup\n```bash\n# install deps\nnpm install\n```',
      '## Next\nDone.',
    ]);
  });

  it('keeps a heading with no body attached to the following section', () => {
    expect(splitSections('# Guide\n## Part one\nBody text.')).toEqual([
      '# Guide\n## Part one\nBody text.',
    ]);
  });
});
