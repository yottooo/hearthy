import { type Config, redactUrl } from './config.js';
import { connect } from './db/client.js';
import { readMeta } from './db/migrate.js';
import { hasModel, LocalModels } from './llm/ollama.js';

type Write = (line: string) => void;

const OK = '✔';
const FAIL = '✖';

/** Prints a health check of every moving part, with a fix-it hint for anything missing. */
export async function printStatus(config: Config, write: Write = console.log): Promise<boolean> {
  const db = await checkDatabase(config, write);
  const ollama = await checkOllama(config, write);
  return db && ollama;
}

async function checkDatabase(config: Config, write: Write): Promise<boolean> {
  let pool;
  try {
    pool = await connect(config.databaseUrl);
  } catch (err) {
    write(`${FAIL} Postgres   ${(err as Error).message.split('\n').join('\n             ')}`);
    return false;
  }

  try {
    write(`${OK} Postgres   ${redactUrl(config.databaseUrl)}`);
    const meta = await readMeta(pool);
    if (!meta) {
      write(`${FAIL} Schema     not initialised → run: hearthy init`);
      return false;
    }
    const matches = meta.embedModel === config.embedModel && meta.embedDim === config.embedDim;
    write(
      `${matches ? OK : FAIL} Schema     built for ${meta.embedModel} (${meta.embedDim} dims)` +
        (matches ? '' : ` but config uses ${config.embedModel} → run: hearthy reset --yes`),
    );
    const { rows } = await pool.query<{ documents: number; chunks: number }>(
      `SELECT (SELECT count(*) FROM documents)::int AS documents,
              (SELECT count(*) FROM chunks)::int AS chunks`,
    );
    const { documents, chunks } = rows[0]!;
    write(`  Library    ${documents} documents, ${chunks} chunks`);
    return matches;
  } finally {
    await pool.end();
  }
}

async function checkOllama(config: Config, write: Write): Promise<boolean> {
  let pulled: string[];
  try {
    pulled = await new LocalModels(config).listModels();
  } catch (err) {
    write(`${FAIL} Ollama     ${(err as Error).message}`);
    return false;
  }

  write(`${OK} Ollama     ${config.ollamaUrl}`);
  let ok = true;
  for (const [role, model] of [
    ['chat', config.chatModel],
    ['embed', config.embedModel],
  ] as const) {
    const present = hasModel(pulled, model);
    ok &&= present;
    write(
      `${present ? OK : FAIL} ${role.padEnd(10)} ${model}${present ? '' : ` → run: ollama pull ${model}`}`,
    );
  }
  return ok;
}
