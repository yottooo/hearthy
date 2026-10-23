import type { Pool } from '../db/client.js';
import { displayPath } from '../ingest/loader.js';
import type { LocalModels } from '../llm/ollama.js';
import { buildMessages, citedPassages } from './prompt.js';
import { retrieve } from './retrieve.js';

export interface AskOptions {
  topK: number;
  /** Print the retrieved passages before the answer. */
  showContext?: boolean;
}

export async function ask(
  question: string,
  { pool, models }: { pool: Pool; models: LocalModels },
  { topK, showContext = false }: AskOptions,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  const [queryEmbedding] = await models.embed([question], 'query');
  const chunks = await retrieve(pool, queryEmbedding!, topK);

  if (chunks.length === 0) {
    write('No documents ingested yet. Run: hearthy ingest <path>\n');
    return;
  }

  if (showContext) {
    for (const [i, chunk] of chunks.entries()) {
      write(`\n── [${i + 1}] ${displayPath(chunk.path)} · score ${chunk.score.toFixed(3)}\n`);
      write(`${chunk.content}\n`);
    }
    write('\n');
  }

  let answer = '';
  for await (const token of models.streamChat(buildMessages(question, chunks, displayPath))) {
    answer += token;
    write(token);
  }

  // Cited passages first, so an answer that cites nothing (or the wrong thing) is easy to spot.
  const cited = citedPassages(answer, chunks.length);
  const source = (i: number) =>
    `  [${i + 1}] ${displayPath(chunks[i]!.path)} (chunk ${chunks[i]!.ord + 1})\n`;
  const indices = [...chunks.keys()];

  write('\n\nSources:\n');
  if (cited.size === 0) write('  (the answer cites no passages)\n');
  for (const i of indices.filter((i) => cited.has(i + 1))) write(source(i));

  const uncited = indices.filter((i) => !cited.has(i + 1));
  if (uncited.length > 0) {
    write('\nAlso retrieved:\n');
    for (const i of uncited) write(source(i));
  }
}
