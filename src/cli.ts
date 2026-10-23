#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { type Config, loadConfig } from './config.js';
import { connect, type Pool } from './db/client.js';
import { assertSchema, dropSchema, migrate } from './db/migrate.js';
import { HearthyError } from './errors.js';
import { ingest } from './ingest/ingest.js';
import { displayPath } from './ingest/loader.js';
import { LocalModels } from './llm/ollama.js';
import { ask } from './rag/ask.js';
import { printStatus } from './status.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const program = new Command()
  .name('hearthy')
  .description(
    'Ask questions about your own documents with a local LLM. Nothing leaves your machine.',
  )
  .version('0.1.0');

program
  .command('init')
  .description('create the database schema (safe to re-run)')
  .action(() =>
    withDatabase(async (pool, config) => {
      await migrate(pool, config);
      console.log(`Database ready (embeddings: ${config.embedModel}, ${config.embedDim} dims).`);
    }),
  );

program
  .command('ingest')
  .description('add a file or folder of .md/.txt documents; unchanged files are skipped')
  .argument('<path>', 'file or directory to ingest')
  .action((target: string) =>
    withDatabase(async (pool, config) => {
      await assertSchema(pool, config);
      const started = performance.now();
      const summary = await ingest(
        target,
        { pool, embedder: new LocalModels(config), config },
        ({ path, status, chunks }) => {
          const mark = { added: '+', updated: '~', unchanged: '=' }[status];
          const detail =
            status === 'unchanged' ? 'unchanged' : `${chunks} chunk${chunks === 1 ? '' : 's'}`;
          console.log(`  ${mark} ${displayPath(path)} (${detail})`);
        },
      );
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log(
        `\n${summary.added} added, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
          `${summary.removed} removed · ${summary.chunks} chunks embedded in ${seconds}s`,
      );
    }),
  );

program
  .command('ask')
  .description('ask a question; the answer cites the passages it used')
  .argument('<question...>', 'your question (quotes optional)')
  .option('-k, --top-k <n>', 'number of passages to retrieve', positiveInt)
  .option('-c, --show-context', 'print the retrieved passages before the answer')
  .action((words: string[], opts: { topK?: number; showContext?: boolean }) =>
    withDatabase(async (pool, config) => {
      await assertSchema(pool, config);
      await ask(
        words.join(' '),
        { pool, models: new LocalModels(config) },
        { topK: opts.topK ?? config.topK, showContext: opts.showContext },
      );
    }),
  );

program
  .command('status')
  .description('check Postgres, Ollama and the configured models')
  .action(() =>
    run(async () => {
      if (!(await printStatus(loadConfig()))) process.exitCode = 1;
    }),
  );

program
  .command('reset')
  .description('delete all ingested documents and the schema')
  .option('--yes', 'confirm deletion')
  .action((opts: { yes?: boolean }) =>
    withDatabase(async (pool) => {
      if (!opts.yes) {
        throw new HearthyError(
          'This deletes every ingested document. Re-run with --yes to confirm.',
        );
      }
      await dropSchema(pool);
      console.log('Database reset. Run "hearthy init" to start again.');
    }),
  );

await program.parseAsync();

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

async function withDatabase(fn: (pool: Pool, config: Config) => Promise<void>): Promise<void> {
  await run(async () => {
    const config = loadConfig();
    const pool = await connect(config.databaseUrl);
    try {
      await fn(pool, config);
    } finally {
      await pool.end();
    }
  });
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HearthyError) {
      console.error(`\n${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  }
}
