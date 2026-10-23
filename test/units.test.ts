import { describe, expect, it } from 'vitest';
import { DEFAULTS, loadConfig, redactUrl } from '../src/config.js';
import { HearthyError, isConnectionRefused } from '../src/errors.js';
import { displayPath } from '../src/ingest/loader.js';
import { embedPrefix, hasModel } from '../src/llm/ollama.js';
import { buildMessages, SYSTEM_PROMPT } from '../src/rag/prompt.js';

describe('loadConfig', () => {
  it('uses defaults for unset or empty variables', () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
    expect(loadConfig({ CHAT_MODEL: '' }).chatModel).toBe(DEFAULTS.chatModel);
  });

  it('parses numeric settings', () => {
    const config = loadConfig({ TOP_K: '8', CHUNK_OVERLAP: '0', CHAT_MODEL: 'qwen2.5:7b' });
    expect(config).toMatchObject({ topK: 8, chunkOverlap: 0, chatModel: 'qwen2.5:7b' });
  });

  it('rejects invalid numbers and overlap >= size', () => {
    expect(() => loadConfig({ TOP_K: 'many' })).toThrow(HearthyError);
    expect(() => loadConfig({ TOP_K: '0' })).toThrow(HearthyError);
    expect(() => loadConfig({ CHUNK_SIZE: '100', CHUNK_OVERLAP: '100' })).toThrow(HearthyError);
  });
});

describe('redactUrl', () => {
  it('hides the password', () => {
    expect(redactUrl('postgres://user:secret@localhost:5433/db')).toBe(
      'postgres://user:****@localhost:5433/db',
    );
  });
});

describe('isConnectionRefused', () => {
  it('finds ECONNREFUSED in nested causes and aggregate errors', () => {
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(isConnectionRefused(new TypeError('fetch failed', { cause: refused }))).toBe(true);
    expect(isConnectionRefused(new AggregateError([new Error('x'), refused]))).toBe(true);
    expect(isConnectionRefused(new Error('other'))).toBe(false);
  });
});

describe('embedPrefix', () => {
  it('labels documents and queries for nomic-embed-text', () => {
    expect(embedPrefix('nomic-embed-text', 'document')).toBe('search_document: ');
    expect(embedPrefix('nomic-embed-text:v1.5', 'query')).toBe('search_query: ');
  });

  it('adds nothing for models without a known prefix', () => {
    expect(embedPrefix('all-minilm', 'query')).toBe('');
  });
});

describe('hasModel', () => {
  const pulled = ['llama3.1:8b', 'nomic-embed-text:latest'];

  it('treats an untagged name as :latest', () => {
    expect(hasModel(pulled, 'nomic-embed-text')).toBe(true);
    expect(hasModel(pulled, 'llama3.1:8b')).toBe(true);
    expect(hasModel(pulled, 'llama3.1')).toBe(false);
  });
});

describe('displayPath', () => {
  it('shows paths under the working directory as relative', () => {
    expect(displayPath('/home/me/notes/a.md', '/home/me')).toBe('notes/a.md');
    expect(displayPath('/elsewhere/b.md', '/home/me')).toBe('/elsewhere/b.md');
  });
});

describe('buildMessages', () => {
  it('numbers each passage with its source and ends with the question', () => {
    const messages = buildMessages(
      'What is E4?',
      [
        { path: '/docs/kettle.md', ord: 0, content: 'E4 means the kettle is dry.', score: 0.9 },
        { path: '/docs/faq.md', ord: 2, content: 'Descale monthly.', score: 0.7 },
      ],
      (p) => p.replace('/docs/', ''),
    );

    expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    const user = messages[1]!.content;
    expect(user).toContain('[1] (source: kettle.md)\nE4 means the kettle is dry.');
    expect(user).toContain('[2] (source: faq.md)\nDescale monthly.');
    expect(user.endsWith('Question: What is E4?')).toBe(true);
  });
});
