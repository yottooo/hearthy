import type { Config } from '../config.js';
import type { Pool } from '../db/client.js';
import { ingest } from '../ingest/ingest.js';
import { displayPath } from '../ingest/loader.js';
import { LocalModels } from '../llm/ollama.js';
import { generateAnswer, retrieveFor } from '../rag/ask.js';
import type { EvalCase, EvalDataset } from './dataset.js';
import { judgeFaithfulness, type Verdict } from './judge.js';
import { type AnswerScore, type RetrievalScore, scoreAnswer, scoreRetrieval } from './scoring.js';

export interface EvalOptions {
  topK: number;
  /** Generate each answer this many times; small models are not perfectly consistent. */
  repeat: number;
  /** Score retrieval only. Fast, and needs just the embedding model. */
  retrievalOnly: boolean;
  /** Grade faithfulness with this model as an LLM judge. */
  judgeModel: string | null;
  /** Only run cases whose id or category contains this text. */
  filter?: string;
}

export interface RunResult {
  answer: string;
  cited: number[];
  score: AnswerScore;
  verdict?: Verdict;
}

export interface CaseResult {
  id: string;
  category: string;
  question: string;
  expect: EvalCase['expect'];
  retrieved: { path: string; ord: number; score: number }[];
  retrieval: RetrievalScore | null;
  runs: RunResult[];
}

export interface EvalReport {
  dataset: string;
  createdAt: string;
  settings: {
    chatModel: string;
    embedModel: string;
    judgeModel: string | null;
    topK: number;
    chunkSize: number;
    chunkOverlap: number;
    repeat: number;
  };
  summary: {
    cases: number;
    retrievalHits: number;
    retrievalCases: number;
    mrr: number;
    answerPasses: number;
    answerRuns: number;
    faithful: number;
    judged: number;
  };
  cases: CaseResult[];
}

export interface EvalDeps {
  pool: Pool;
  models: LocalModels;
  config: Config;
}

type Write = (line: string) => void;

export async function runEval(
  dataset: EvalDataset,
  deps: EvalDeps,
  options: EvalOptions,
  write: Write = console.log,
): Promise<EvalReport> {
  const { pool, models, config } = deps;
  const judge = options.judgeModel
    ? new LocalModels({ ...config, chatModel: options.judgeModel })
    : null;
  const cases = dataset.cases.filter(
    (c) => !options.filter || c.id.includes(options.filter) || c.category.includes(options.filter),
  );

  // Make sure the documents the questions are about are in the library (unchanged files are skipped).
  const ingested = await ingest(dataset.documents, { pool, embedder: models, config });
  write(
    `Documents: ${displayPath(dataset.documents)} ` +
      `(${ingested.added + ingested.updated} embedded, ${ingested.unchanged} unchanged)`,
  );
  const others = await countOtherDocuments(pool, dataset.documents);
  if (others > 0) {
    write(
      `Note: ${others} other document(s) are in the library too and will compete in retrieval.`,
    );
  }
  write(
    `Running ${cases.length} cases · ${config.chatModel} · ${config.embedModel} · top-${options.topK}` +
      (options.repeat > 1 ? ` · ${options.repeat} runs each` : '') +
      '\n',
  );

  const results: CaseResult[] = [];
  for (const c of cases) {
    const chunks = await retrieveFor(c.question, deps, options.topK);
    const retrieval = scoreRetrieval(c, chunks);
    const runs: RunResult[] = [];

    if (!options.retrievalOnly) {
      for (let i = 0; i < options.repeat; i++) {
        const answer = await generateAnswer(c.question, chunks, models);
        const run: RunResult = {
          answer: answer.text,
          cited: [...answer.cited].sort((a, b) => a - b),
          score: scoreAnswer(c, answer.text, answer.cited, chunks),
        };
        if (judge) {
          run.verdict = await judgeFaithfulness(judge, c.question, chunks, answer.text);
        }
        runs.push(run);
      }
    }

    const result: CaseResult = {
      id: c.id,
      category: c.category,
      question: c.question,
      expect: c.expect,
      retrieved: chunks.map(({ path, ord, score }) => ({ path, ord, score })),
      retrieval,
      runs,
    };
    results.push(result);
    printCase(result, options, write);
  }

  const report = buildReport(dataset, results, deps.config, options);
  printSummary(report, options, write);
  return report;
}

async function countOtherDocuments(pool: Pool, dir: string): Promise<number> {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM documents WHERE NOT starts_with(path, $1)',
    [prefix],
  );
  return rows[0]!.n;
}

function printCase(result: CaseResult, options: EvalOptions, write: Write): void {
  const { retrieval, runs } = result;
  const passes = runs.filter((r) => r.score.pass).length;
  const ok = options.retrievalOnly ? retrieval?.hit !== false : passes === runs.length;

  const retrievalText = !retrieval
    ? 'n/a'
    : retrieval.hit
      ? `rank ${retrieval.ranks.join(',')}`
      : 'MISSED';
  let line =
    `${ok ? '✔' : '✖'} ${result.id.padEnd(20)} ${result.category.padEnd(14)} ` +
    `retrieval ${retrievalText.padEnd(9)}`;
  if (!options.retrievalOnly) line += ` answer ${passes}/${runs.length}`;
  if (options.judgeModel) {
    line += `  faithful ${runs.filter((r) => r.verdict?.faithful).length}/${runs.length}`;
  }
  write(line);

  const failed = runs.find((r) => !r.score.pass);
  if (failed) {
    // The key diagnostic: did we never find the answer, or find it and then fumble it?
    const stage = retrieval && !retrieval.hit ? 'retrieval miss' : 'generation';
    write(`    ↳ ${stage}: ${failed.score.failures.join('; ')}`);
    write(`      "${truncate(failed.answer, 140)}"`);
  }
  const unfaithful = runs.find((r) => r.verdict && !r.verdict.faithful);
  if (unfaithful) write(`    ↳ judge: ${unfaithful.verdict!.reason}`);
}

function buildReport(
  dataset: EvalDataset,
  cases: CaseResult[],
  config: Config,
  options: EvalOptions,
): EvalReport {
  const withRetrieval = cases.filter((c) => c.retrieval);
  const runs = cases.flatMap((c) => c.runs);
  const judged = runs.filter((r) => r.verdict);
  return {
    dataset: dataset.name,
    createdAt: new Date().toISOString(),
    settings: {
      chatModel: config.chatModel,
      embedModel: config.embedModel,
      judgeModel: options.judgeModel,
      topK: options.topK,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      repeat: options.repeat,
    },
    summary: {
      cases: cases.length,
      retrievalHits: withRetrieval.filter((c) => c.retrieval!.hit).length,
      retrievalCases: withRetrieval.length,
      mrr: mean(withRetrieval.map((c) => c.retrieval!.reciprocalRank)),
      answerPasses: runs.filter((r) => r.score.pass).length,
      answerRuns: runs.length,
      faithful: judged.filter((r) => r.verdict!.faithful).length,
      judged: judged.length,
    },
    cases,
  };
}

function printSummary(report: EvalReport, options: EvalOptions, write: Write): void {
  const categories = [...new Set(report.cases.map((c) => c.category))];
  write('\nSummary');
  write(
    `  ${'category'.padEnd(16)} ${'retrieval'.padEnd(12)} ${options.retrievalOnly ? '' : 'answers'}`,
  );

  for (const category of categories) {
    const cases = report.cases.filter((c) => c.category === category);
    const withRetrieval = cases.filter((c) => c.retrieval);
    const runs = cases.flatMap((c) => c.runs);
    const retrieval = withRetrieval.length
      ? ratio(withRetrieval.filter((c) => c.retrieval!.hit).length, withRetrieval.length)
      : 'n/a';
    const answers = options.retrievalOnly
      ? ''
      : ratio(runs.filter((r) => r.score.pass).length, runs.length);
    write(`  ${category.padEnd(16)} ${retrieval.padEnd(12)} ${answers}`);
  }

  const s = report.summary;
  write(
    `  ${'overall'.padEnd(16)} ${ratio(s.retrievalHits, s.retrievalCases).padEnd(12)} ` +
      (options.retrievalOnly ? '' : ratio(s.answerPasses, s.answerRuns)),
  );
  write(
    `\n  retrieval hit rate ${percent(s.retrievalHits, s.retrievalCases)}, MRR ${s.mrr.toFixed(2)}` +
      (options.retrievalOnly ? '' : ` · answers pass ${percent(s.answerPasses, s.answerRuns)}`) +
      (s.judged > 0
        ? ` · faithful ${percent(s.faithful, s.judged)} (judge: ${report.settings.judgeModel})`
        : ''),
  );
}

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const ratio = (n: number, total: number) => `${n}/${total}`;
const percent = (n: number, total: number) =>
  total === 0 ? 'n/a' : `${Math.round((100 * n) / total)}%`;
const truncate = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
