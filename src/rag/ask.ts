import type { Pool } from '../db/client.js';
import { displayPath } from '../ingest/loader.js';
import type { LocalModels } from '../llm/ollama.js';
import { buildMessages } from './prompt.js';
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

  for await (const token of models.streamChat(buildMessages(question, chunks, displayPath))) {
    write(token);
  }

  write('\n\nSources:\n');
  for (const [i, chunk] of chunks.entries()) {
    write(`  [${i + 1}] ${displayPath(chunk.path)} (chunk ${chunk.ord + 1})\n`);
  }
}
