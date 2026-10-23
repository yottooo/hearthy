import { toSql } from 'pgvector';
import type { Pool } from '../db/client.js';

export interface RetrievedChunk {
  path: string;
  ord: number;
  content: string;
  /** Cosine similarity, 1 = identical direction. */
  score: number;
}

/** Returns the `k` chunks closest to the query embedding, using the HNSW index. */
export async function retrieve(
  pool: Pool,
  queryEmbedding: number[],
  k: number,
): Promise<RetrievedChunk[]> {
  const { rows } = await pool.query<RetrievedChunk>(
    `SELECT d.path, c.ord, c.content, 1 - (c.embedding <=> $1) AS score
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     ORDER BY c.embedding <=> $1
     LIMIT $2`,
    [toSql(queryEmbedding), k],
  );
  return rows;
}
