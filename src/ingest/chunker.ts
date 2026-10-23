export interface ChunkOptions {
  /** Target maximum chunk length in characters. */
  size: number;
  /** Characters of trailing context carried into the next chunk of the same section. */
  overlap: number;
}

/**
 * Splits progressively finer: paragraphs, then lines, then sentences, then words.
 * A piece is only split further when it alone is larger than the chunk size.
 */
const SEPARATORS: { pattern: RegExp; joiner: string }[] = [
  { pattern: /\n[ \t]*\n/, joiner: '\n\n' },
  { pattern: /\n/, joiner: '\n' },
  { pattern: /(?<=[.!?])\s+/, joiner: ' ' },
  { pattern: /\s+/, joiner: ' ' },
];

/**
 * Splits text into retrieval-sized chunks.
 *
 * Markdown headings start a new section and chunks never span two sections, so each chunk stays
 * about one topic. Inside a section, paragraphs are packed greedily up to `size`, with `overlap`
 * characters of context repeated at the start of the following chunk.
 */
export function chunkText(text: string, { size, overlap }: ChunkOptions): string[] {
  if (overlap >= size) throw new RangeError('overlap must be smaller than size');
  return splitSections(text.replace(/\r\n?/g, '\n')).flatMap((section) =>
    splitRecursive(section, size, overlap, 0),
  );
}

/** Splits markdown at headings, ignoring `#` lines inside fenced code blocks. */
export function splitSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const isHeading = !inFence && /^#{1,6}\s/.test(line);
    // A heading with no body yet stays attached to the heading that follows it.
    if (isHeading && current.some((l) => l.trim() && !/^#{1,6}\s/.test(l))) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join('\n'));
  return sections.map((s) => s.trim()).filter(Boolean);
}

function splitRecursive(text: string, size: number, overlap: number, level: number): string[] {
  if (text.length <= size) return [text];
  const separator = SEPARATORS[level];
  if (!separator) return hardSplit(text, size, overlap);

  const pieces = text
    .split(separator.pattern)
    .map((p) => p.trimEnd())
    .filter((p) => p.trim())
    .flatMap((p) => (p.length > size ? splitRecursive(p, size, overlap, level + 1) : [p]));
  return merge(pieces, separator.joiner, size, overlap);
}

/** Packs pieces into chunks of at most `size`, carrying up to `overlap` chars of trailing pieces. */
function merge(pieces: string[], joiner: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let window: string[] = [];
  let length = 0;

  for (const piece of pieces) {
    if (window.length > 0 && length + joiner.length + piece.length > size) {
      chunks.push(window.join(joiner));
      while (
        window.length > 0 &&
        (length > overlap || length + joiner.length + piece.length > size)
      ) {
        length -= window[0]!.length + (window.length > 1 ? joiner.length : 0);
        window = window.slice(1);
      }
    }
    length += (window.length > 0 ? joiner.length : 0) + piece.length;
    window.push(piece);
  }
  if (window.length > 0) chunks.push(window.join(joiner));
  return chunks;
}

/** Last resort for text with no usable separators, e.g. a very long token. */
function hardSplit(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}
