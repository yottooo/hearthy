import type { Message } from 'ollama';
import type { RetrievedChunk } from './retrieve.js';

export const SYSTEM_PROMPT = `You are Hearthy, an assistant that answers questions about the user's own documents.

Rules:
- Answer using only the numbered context passages provided. Do not use outside knowledge.
- Cite the passages you rely on with their numbers in square brackets, like [1] or [2][3].
- If the context does not contain the answer, say that you could not find it in the documents.
- Be concise and direct.`;

/** Passage numbers the answer actually cites, e.g. "[1]", "[2][3]" or "[1, 4]", ignoring out-of-range ones. */
export function citedPassages(answer: string, passageCount: number): Set<number> {
  const cited = new Set<number>();
  for (const [, group] of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of group!.split(',').map(Number)) {
      if (n >= 1 && n <= passageCount) cited.add(n);
    }
  }
  return cited;
}

/** Builds the chat messages: rules in the system prompt, numbered passages plus the question as the user turn. */
export function buildMessages(
  question: string,
  chunks: RetrievedChunk[],
  displayPath: (path: string) => string = (p) => p,
): Message[] {
  const context = chunks
    .map((chunk, i) => `[${i + 1}] (source: ${displayPath(chunk.path)})\n${chunk.content}`)
    .join('\n\n---\n\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Context:\n\n${context}\n\n---\n\nQuestion: ${question}` },
  ];
}
