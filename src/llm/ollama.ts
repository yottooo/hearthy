import { Ollama, type Message } from 'ollama';
import type { Config } from '../config.js';
import { HearthyError, isConnectionRefused } from '../errors.js';

export type EmbedKind = 'document' | 'query';

export interface Embedder {
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

/**
 * Some embedding models were trained with task prefixes and retrieve noticeably better when
 * documents and queries are labelled the way they saw during training.
 */
export function embedPrefix(model: string, kind: EmbedKind): string {
  if (model.startsWith('nomic-embed-text')) {
    return kind === 'document' ? 'search_document: ' : 'search_query: ';
  }
  if (model.startsWith('mxbai-embed-large')) {
    return kind === 'query' ? 'Represent this sentence for searching relevant passages: ' : '';
  }
  return '';
}

const EMBED_BATCH_SIZE = 32;

export class LocalModels implements Embedder {
  private readonly client: Ollama;

  constructor(private readonly config: Config) {
    this.client = new Ollama({ host: config.ollamaUrl });
  }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    const { embedModel, embedDim } = this.config;
    const prefix = embedPrefix(embedModel, kind);
    const vectors: number[][] = [];

    // Batching keeps HTTP overhead low; the GPU does the heavy lifting either way.
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const input = texts.slice(i, i + EMBED_BATCH_SIZE).map((t) => prefix + t);
      const { embeddings } = await this.call(embedModel, () =>
        this.client.embed({ model: embedModel, input, truncate: true }),
      );
      vectors.push(...embeddings);
    }

    const wrongDim = vectors.find((v) => v.length !== embedDim);
    if (wrongDim) {
      throw new HearthyError(
        `${embedModel} returned ${wrongDim.length}-dimensional vectors but EMBED_DIM is ${embedDim}. ` +
          'Set EMBED_DIM to match the model.',
      );
    }
    return vectors;
  }

  /** Streams the assistant's reply token by token. */
  async *streamChat(messages: Message[]): AsyncGenerator<string> {
    const { chatModel, numCtx } = this.config;
    const stream = await this.call(chatModel, () =>
      this.client.chat({
        model: chatModel,
        messages,
        stream: true,
        options: { num_ctx: numCtx, temperature: 0.2 },
      }),
    );
    for await (const part of stream) {
      yield part.message.content;
    }
  }

  /** One deterministic reply constrained to a JSON schema, e.g. for grading. */
  async completeJson<T>(messages: Message[], schema: object): Promise<T> {
    const { chatModel, numCtx } = this.config;
    const response = await this.call(chatModel, () =>
      this.client.chat({
        model: chatModel,
        messages,
        format: schema,
        options: { num_ctx: numCtx, temperature: 0 },
      }),
    );
    return JSON.parse(response.message.content) as T;
  }

  /** Names of locally pulled models, e.g. "llama3.1:8b" or "nomic-embed-text:latest". */
  async listModels(): Promise<string[]> {
    const { models } = await this.call(null, () => this.client.list());
    return models.map((m) => m.name);
  }

  private async call<T>(model: string | null, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isConnectionRefused(err)) {
        throw new HearthyError(
          `Cannot reach Ollama at ${this.config.ollamaUrl}. Is it running? Install it from https://ollama.com`,
          { cause: err },
        );
      }
      if (model && err instanceof Error && 'status_code' in err && err.status_code === 404) {
        throw new HearthyError(`Model "${model}" is not available. Run: ollama pull ${model}`, {
          cause: err,
        });
      }
      throw err;
    }
  }
}

/** Matches "llama3.1:8b" against pulled names, treating a missing tag as ":latest". */
export function hasModel(pulled: string[], model: string): boolean {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  return pulled.some((name) => name === model || name === wanted);
}
