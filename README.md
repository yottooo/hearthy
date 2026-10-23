# Hearthy

**Your documents, your hardware.** A local RAG (retrieval-augmented generation) CLI in TypeScript.

[![CI](https://github.com/yottooo/hearthy/actions/workflows/ci.yml/badge.svg)](https://github.com/yottooo/hearthy/actions/workflows/ci.yml)
![Node 24+](https://img.shields.io/badge/node-24%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Point Hearthy at a folder of notes or docs, then ask questions about them in plain language. It finds
the passages that matter, has a local LLM answer from those passages only, and cites the file each
part of the answer came from. Models run in [Ollama](https://ollama.com) and vectors live in
Postgres + [pgvector](https://github.com/pgvector/pgvector). No API keys, and nothing leaves your
machine.

```text
$ hearthy ask "Who do I page if production is down at night?"

According to [1], if production is down between 19:00 and 08:00, page the on-call engineer
through the Pager app. If they don't acknowledge within 15 minutes, the page escalates to the
Head of Engineering, Mira Petrova.

Sources:
  [1] examples/docs/emberlight-handbook.md (chunk 3)

Also retrieved:
  [2] examples/docs/emberlight-handbook.md (chunk 1)
  [3] examples/docs/kettle-k2-manual.md (chunk 2)
  ...
```

Real output from `llama3.1:8b` on an RTX 3070, using the [example documents](examples/docs).

## How it works

```mermaid
flowchart LR
  subgraph Ingest["hearthy ingest ./docs"]
    F[".md / .txt files"] --> H{"changed?<br/>(SHA-256)"}
    H -- yes --> C["chunker<br/>heading-aware, ~1000 chars"]
    C --> E1["nomic-embed-text<br/>(Ollama, GPU)"]
    E1 --> DB[("Postgres + pgvector<br/>HNSW index")]
  end

  subgraph Ask["hearthy ask &quot;...&quot;"]
    Q["question"] --> E2["nomic-embed-text"]
    E2 --> R["top-k cosine search"]
    DB --> R
    R --> P["prompt: rules +<br/>numbered passages"]
    P --> L["llama3.1:8b<br/>(Ollama, GPU)"]
    L --> A["streamed answer<br/>with [n] citations"]
  end
```

1. **Ingest:** each file is hashed, so unchanged files are skipped on the next run. Changed files are
   split into chunks, embedded in batches, and stored in a single transaction. Files deleted from an
   ingested folder are removed from the database too.
2. **Retrieve:** the question is embedded with the same model, and pgvector returns the closest chunks
   by cosine similarity.
3. **Generate:** the chunks go to the chat model as numbered passages, with instructions to answer
   only from them, cite them as `[n]`, and say so when the answer isn't there.

## Hardware

Hearthy is developed on an **Intel i7-4770 with an RTX 3070 (8 GB VRAM)**. The defaults are chosen so
that the chat model and the embedding model both fit on an 8 GB card at the same time, with room left
for an 8K context window. The old CPU only reads files and talks HTTP, so it is not the bottleneck.

On that machine, `ollama ps` shows `llama3.1:8b` at 5.8 GB (with the 8K context) and
`nomic-embed-text` at 0.3 GB, both running 100% on the GPU.

Pick a chat model that fits your GPU and set `CHAT_MODEL` in `.env`:

| VRAM     | Suggested `CHAT_MODEL`                | Download size |
| -------- | ------------------------------------- | ------------- |
| 4–6 GB   | `llama3.2:3b`                         | ~2 GB         |
| 8 GB     | `llama3.1:8b` (default), `qwen2.5:7b` | ~5 GB         |
| 12 GB+   | `qwen2.5:14b`                         | ~9 GB         |
| CPU only | `llama3.2:3b` (works, but slowly)     | ~2 GB         |

The embedding model (`nomic-embed-text`, ~0.3 GB) is small enough to sit alongside any of these.

## Prerequisites

- Node.js 24+
- Docker Desktop (with Docker Compose)
- [Ollama](https://ollama.com/download)

## Quickstart

1. Pull the models

   ```bash
   ollama pull llama3.1:8b
   ollama pull nomic-embed-text
   ```

2. Install, build, and link the `hearthy` command

   ```bash
   npm install
   npm run build
   npm link
   ```

   Without `npm link`, run `node dist/cli.js <command>` instead of `hearthy <command>`.

3. Create your `.env` and start Postgres

   ```bash
   cp .env.example .env
   npm run db:up
   ```

   Postgres is published on port **5433** so it won't clash with another Postgres on 5432.

4. Create the schema and check everything is connected

   ```bash
   hearthy init
   hearthy status
   ```

5. Ingest the example documents and ask a question

   ```bash
   hearthy ingest ./examples/docs
   hearthy ask "How many days of remote work does Emberlight allow?"
   ```

   The examples describe a made-up kettle and company, so the model can only get these answers
   right by retrieving them. See [examples/README.md](examples/README.md) for more
   questions. Then point it at your own folders.

## Commands

| Command                     | What it does                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `hearthy init`              | Creates the schema. Safe to re-run.                                                |
| `hearthy ingest <path>`     | Adds a file or folder of `.md`/`.txt` files. Skips `node_modules`, `.git`, etc.    |
| `hearthy ask <question>`    | Answers from your documents. `-k <n>` sets how many passages to retrieve.          |
| `hearthy ask -c <question>` | Also prints the retrieved passages and their similarity scores (for debugging).    |
| `hearthy status`            | Checks Postgres, the schema, Ollama and the models, and tells you how to fix them. |
| `hearthy reset --yes`       | Deletes all ingested documents and the schema.                                     |

## Configuration

All settings are optional and read from `.env` (see [.env.example](.env.example)).

| Variable        | Default                                             | Notes                                           |
| --------------- | --------------------------------------------------- | ----------------------------------------------- |
| `DATABASE_URL`  | `postgres://hearthy:hearthy@localhost:5433/hearthy` | Matches `docker-compose.yml`                    |
| `OLLAMA_URL`    | `http://127.0.0.1:11434`                            |                                                 |
| `CHAT_MODEL`    | `llama3.1:8b`                                       | See [Hardware](#hardware)                       |
| `EMBED_MODEL`   | `nomic-embed-text`                                  | Changing it requires `reset` and re-ingest      |
| `EMBED_DIM`     | `768`                                               | Must match the embedding model                  |
| `NUM_CTX`       | `8192`                                              | Chat context window in tokens                   |
| `TOP_K`         | `5`                                                 | Passages per question                           |
| `CHUNK_SIZE`    | `1000`                                              | Max characters per chunk                        |
| `CHUNK_OVERLAP` | `150`                                               | Characters repeated between neighbouring chunks |

## Design notes

- **Why pgvector?** It keeps documents, chunks and vectors in one transactional store, queryable
  with plain SQL. An HNSW index keeps search fast as the library grows. It also leaves room for
  hybrid search with Postgres full-text search later.
- **Chunking:** chunks never span two markdown headings, so each chunk stays about one topic. Inside a
  section, text is split by paragraph, then line, then sentence, then word, only as far as needed to
  fit the size limit. `#` comments inside code fences are not mistaken for headings.
- **Embedding prefixes:** `nomic-embed-text` was trained with `search_document:` and `search_query:`
  task prefixes, and retrieves noticeably better when you use them. Hearthy adds them automatically.
- **One embedding model per database:** vectors from different models aren't comparable. `init`
  records the model and dimensions, and every command refuses to mix them.
- **Grounded answers:** the model is told to answer only from the numbered passages and to cite
  them. Sources are always printed, so you can check the answer.

## Project structure

```text
src/
├─ cli.ts             commands and error handling
├─ config.ts          .env → typed, validated config
├─ status.ts          health checks for `hearthy status`
├─ db/                connection + schema migration
├─ ingest/            file discovery, chunking, ingest pipeline
├─ llm/ollama.ts      embeddings + streaming chat via Ollama
└─ rag/               retrieval, prompt building, `ask`
test/                 unit tests + pgvector integration test
examples/docs/        sample documents to try it on
```

## Development

```bash
npm run dev -- ask "..."   # run from source with tsx, no build step
npm test                   # unit tests
npm run lint
npm run typecheck
npm run format
```

The integration test in `test/pipeline.test.ts` runs the real ingest and retrieval pipeline against
pgvector, using a deterministic fake embedder in place of Ollama. It runs when `TEST_DATABASE_URL` is
set. Docker Compose creates the `hearthy_test` database for you, so uncomment that line in `.env` and
run `npm test`. CI runs it against a pgvector service container on every push.

## Roadmap

- [x] Ingest `.md` / `.txt` with change detection and cleanup of deleted files
- [x] Heading-aware recursive chunking
- [x] pgvector storage with an HNSW index
- [x] Streaming, cited answers via Ollama
- [x] `status` health checks with fix-it hints
- [x] CI with a real pgvector integration test
- [ ] PDF and DOCX loaders
- [ ] Hybrid search (pgvector + Postgres full-text search)
- [ ] Reranking retrieved passages
- [ ] Follow-up questions (chat mode)
- [ ] An evaluation set to measure retrieval quality
- [ ] `ingest --watch`
- [ ] Ollama in Docker Compose with a GPU profile
- [ ] Web UI

## License

[MIT](LICENSE)
