import type { Pool } from '../db/client.js';
import { displayPath } from '../ingest/loader.js';
import type { LocalModels } from '../llm/ollama.js';
import { buildMessages, citedPassages } from './prompt.js';
import { retrieve, type RetrievedChunk } from './retrieve.js';

export interface AskOptions {
  topK: number;
  /** Print the retrieved passages before the answer. */
  showContext?: boolean;
}

export interface Answer {
  text: string;
  /** 1-based passage numbers the answer cites. */
  cited: Set<number>;
}

/** Step 1 of RAG: embed the question and fetch the nearest chunks. */
export async function retrieveFor(
  question: string,
  { pool, models }: { pool: Pool; models: LocalModels },
  topK: number,
): Promise<RetrievedChunk[]> {
  const [queryEmbedding] = await models.embed([question], 'query');
  return retrieve(pool, queryEmbedding!, topK);
}

/** Step 2 of RAG: have the chat model answer from the retrieved chunks. */
export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  models: LocalModels,
  onToken: (token: string) => void = () => {},
): Promise<Answer> {
  let text = '';
  for await (const token of models.streamChat(buildMessages(question, chunks, displayPath))) {
    text += token;
    onToken(token);
  }
  return { text, cited: citedPassages(text, chunks.length) };
}

export async function ask(
  question: string,
  deps: { pool: Pool; models: LocalModels },
  { topK, showContext = false }: AskOptions,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  const chunks = await retrieveFor(question, deps, topK);

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

  const { cited } = await generateAnswer(question, chunks, deps.models, write);

  // Cited passages first, so an answer that cites nothing (or the wrong thing) is easy to spot.
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
