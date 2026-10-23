import { HearthyError } from './errors.js';

export interface Config {
  databaseUrl: string;
  ollamaUrl: string;
  chatModel: string;
  embedModel: string;
  embedDim: number;
  numCtx: number;
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
}

export const DEFAULTS: Config = {
  databaseUrl: 'postgres://hearthy:hearthy@localhost:5433/hearthy',
  ollamaUrl: 'http://127.0.0.1:11434',
  chatModel: 'llama3.1:8b',
  embedModel: 'nomic-embed-text',
  embedDim: 768,
  numCtx: 8192,
  topK: 5,
  chunkSize: 1000,
  chunkOverlap: 150,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    databaseUrl: env.DATABASE_URL || DEFAULTS.databaseUrl,
    ollamaUrl: env.OLLAMA_URL || DEFAULTS.ollamaUrl,
    chatModel: env.CHAT_MODEL || DEFAULTS.chatModel,
    embedModel: env.EMBED_MODEL || DEFAULTS.embedModel,
    embedDim: positiveInt(env, 'EMBED_DIM', DEFAULTS.embedDim),
    numCtx: positiveInt(env, 'NUM_CTX', DEFAULTS.numCtx),
    topK: positiveInt(env, 'TOP_K', DEFAULTS.topK),
    chunkSize: positiveInt(env, 'CHUNK_SIZE', DEFAULTS.chunkSize),
    chunkOverlap: positiveInt(env, 'CHUNK_OVERLAP', DEFAULTS.chunkOverlap, { allowZero: true }),
  };

  if (config.chunkOverlap >= config.chunkSize) {
    throw new HearthyError('CHUNK_OVERLAP must be smaller than CHUNK_SIZE.');
  }
  return config;
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { allowZero = false } = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new HearthyError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer.`);
  }
  return value;
}

/** Database URL with the password hidden, for printing. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '****';
    return parsed.toString();
  } catch {
    return url;
  }
}
