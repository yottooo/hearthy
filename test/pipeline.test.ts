/**
 * End-to-end pipeline test against a real Postgres + pgvector, with a deterministic fake embedder
 * standing in for Ollama. Runs only when TEST_DATABASE_URL is set (see README → Development).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from '../src/config.js';
import { connect, type Pool } from '../src/db/client.js';
import { assertSchema, dropSchema, migrate } from '../src/db/migrate.js';
import { HearthyError } from '../src/errors.js';
import { ingest } from '../src/ingest/ingest.js';
import type { Embedder } from '../src/llm/ollama.js';
import { retrieve } from '../src/rag/retrieve.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = process.env.TEST_DATABASE_URL;
const config: Config = { ...DEFAULTS, databaseUrl: databaseUrl ?? '' };

/** Bag-of-words hashing: texts sharing words get similar vectors, which is all retrieval needs here. */
const fakeEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Array<number>(config.embedDim).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let hash = 2166136261;
        for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        vector[(hash >>> 0) % config.embedDim]! += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((v) => v / norm);
    });
  },
};

describe.skipIf(!databaseUrl)('pipeline (Postgres + pgvector)', () => {
  let pool: Pool;
  let dir: string;
  const deps = () => ({ pool, embedder: fakeEmbedder, config });

  beforeAll(async () => {
    pool = await connect(config.databaseUrl);
  });

  afterAll(async () => {
    await dropSchema(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await dropSchema(pool);
    await migrate(pool, config);
    dir = await mkdtemp(path.join(tmpdir(), 'hearthy-'));
    await writeFile(
      path.join(dir, 'kettle.md'),
      '# Kettle K2\nError E4 means the kettle is dry. Fill water and reset.',
    );
    await writeFile(path.join(dir, 'garden.txt'), 'Water tomatoes every morning in summer.');
    await writeFile(path.join(dir, 'ignored.json'), '{"not": "ingested"}');
    return () => rm(dir, { recursive: true, force: true });
  });

  it('ingests supported files and retrieves the most relevant chunk first', async () => {
    const summary = await ingest(dir, deps());
    expect(summary).toMatchObject({ added: 2, updated: 0, unchanged: 0, removed: 0 });

    const [query] = await fakeEmbedder.embed(['what does kettle error E4 mean'], 'query');
    const results = await retrieve(pool, query!, 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.path.endsWith('/kettle.md')).toBe(true);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('skips unchanged files, replaces changed ones and removes deleted ones', async () => {
    await ingest(dir, deps());

    await writeFile(path.join(dir, 'garden.txt'), 'Water tomatoes twice a day in a heatwave.');
    await unlink(path.join(dir, 'kettle.md'));
    const summary = await ingest(dir, deps());
    expect(summary).toMatchObject({ added: 0, updated: 1, unchanged: 0, removed: 1 });

    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM chunks');
    expect(rows[0]!.n).toBe(1);

    expect(await ingest(dir, deps())).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it('refuses to run against a schema built for a different embedding model', async () => {
    await expect(assertSchema(pool, { ...config, embedModel: 'other-model' })).rejects.toThrow(
      HearthyError,
    );
  });
});
