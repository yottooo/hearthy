import { stat } from 'node:fs/promises';
import { toSql } from 'pgvector';
import type { Config } from '../config.js';
import type { Pool } from '../db/client.js';
import type { Embedder } from '../llm/ollama.js';
import { chunkText } from './chunker.js';
import { findFiles, loadFile, toDocumentPath } from './loader.js';

export type FileStatus = 'added' | 'updated' | 'unchanged';

export interface FileEvent {
  path: string;
  status: FileStatus;
  chunks: number;
}

export interface IngestSummary {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  chunks: number;
}

export interface IngestDeps {
  pool: Pool;
  embedder: Embedder;
  config: Pick<Config, 'chunkSize' | 'chunkOverlap'>;
}

/**
 * Ingests a file or directory. Unchanged files (same SHA-256) are skipped, changed files have their
 * chunks replaced, and documents under an ingested directory that no longer exist on disk are removed.
 */
export async function ingest(
  target: string,
  { pool, embedder, config }: IngestDeps,
  onFile: (event: FileEvent) => void = () => {},
): Promise<IngestSummary> {
  const files = await findFiles(target);
  const summary: IngestSummary = { added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0 };

  for (const filePath of files) {
    const file = await loadFile(filePath);
    const { rows } = await pool.query<{ sha256: string }>(
      'SELECT sha256 FROM documents WHERE path = $1',
      [file.path],
    );
    const existing = rows[0];

    if (existing?.sha256 === file.sha256) {
      summary.unchanged++;
      onFile({ path: file.path, status: 'unchanged', chunks: 0 });
      continue;
    }

    const chunks = chunkText(file.content, {
      size: config.chunkSize,
      overlap: config.chunkOverlap,
    });
    // Embed before opening the transaction so a slow model never holds a connection open.
    const embeddings = await embedder.embed(chunks, 'document');
    await replaceDocument(pool, file.path, file.sha256, chunks, embeddings);

    const status: FileStatus = existing ? 'updated' : 'added';
    summary[status]++;
    summary.chunks += chunks.length;
    onFile({ path: file.path, status, chunks: chunks.length });
  }

  if ((await stat(target)).isDirectory()) {
    summary.removed = await removeMissing(pool, toDocumentPath(target), files);
  }
  return summary;
}

async function replaceDocument(
  pool: Pool,
  path: string,
  sha256: string,
  chunks: string[],
  embeddings: number[][],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO documents (path, sha256) VALUES ($1, $2)
       ON CONFLICT (path) DO UPDATE SET sha256 = EXCLUDED.sha256, ingested_at = now()
       RETURNING id`,
      [path, sha256],
    );
    const documentId = rows[0]!.id;
    await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);
    for (const [ord, content] of chunks.entries()) {
      await client.query(
        'INSERT INTO chunks (document_id, ord, content, embedding) VALUES ($1, $2, $3, $4)',
        [documentId, ord, content, toSql(embeddings[ord]!)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Deletes documents stored under `dir` that were not found on disk this time. */
async function removeMissing(pool: Pool, dir: string, found: string[]): Promise<number> {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const { rowCount } = await pool.query(
    'DELETE FROM documents WHERE starts_with(path, $1) AND NOT (path = ANY($2::text[]))',
    [prefix, found],
  );
  return rowCount ?? 0;
}
