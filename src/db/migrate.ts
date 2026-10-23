import type { Config } from '../config.js';
import { HearthyError } from '../errors.js';
import type { Pool } from './client.js';

interface SchemaMeta {
  embedModel: string;
  embedDim: number;
}

function schemaSql(embedDim: number): string {
  return `
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS hearthy_meta (
      key   text PRIMARY KEY,
      value text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id          serial PRIMARY KEY,
      path        text NOT NULL UNIQUE,
      sha256      text NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          bigserial PRIMARY KEY,
      document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ord         integer NOT NULL,
      content     text NOT NULL,
      embedding   vector(${embedDim}) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);
    CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
  `;
}

/** Creates the schema and records which embedding model it was built for. Safe to re-run. */
export async function migrate(pool: Pool, config: Config): Promise<void> {
  const existing = await readMeta(pool);
  if (existing) assertCompatible(existing, config);

  await pool.query(schemaSql(config.embedDim));
  await pool.query(
    `INSERT INTO hearthy_meta (key, value) VALUES ('embed_model', $1), ('embed_dim', $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [config.embedModel, String(config.embedDim)],
  );
}

/** Fails unless `init` has run with the same embedding model as the current config. */
export async function assertSchema(pool: Pool, config: Config): Promise<void> {
  const meta = await readMeta(pool);
  if (!meta) throw new HearthyError('The database is not initialised. Run: hearthy init');
  assertCompatible(meta, config);
}

export async function readMeta(pool: Pool): Promise<SchemaMeta | null> {
  const { rows: tables } = await pool.query<{ t: string | null }>(
    `SELECT to_regclass('hearthy_meta')::text AS t`,
  );
  if (!tables[0]?.t) return null;

  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM hearthy_meta',
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const embedModel = values.get('embed_model');
  const embedDim = Number(values.get('embed_dim'));
  return embedModel && embedDim ? { embedModel, embedDim } : null;
}

export async function dropSchema(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS chunks, documents, hearthy_meta');
}

function assertCompatible(meta: SchemaMeta, config: Config): void {
  if (meta.embedModel !== config.embedModel || meta.embedDim !== config.embedDim) {
    throw new HearthyError(
      `The database was built with ${meta.embedModel} (${meta.embedDim} dims), ` +
        `but the config uses ${config.embedModel} (${config.embedDim} dims).\n` +
        'Embeddings from different models are not comparable. Either change EMBED_MODEL/EMBED_DIM back, ' +
        'or run "hearthy reset --yes" and ingest your documents again.',
    );
  }
}
