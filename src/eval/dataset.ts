import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HearthyError } from '../errors.js';

export type Expectation = 'answer' | 'refuse';

export interface EvalCase {
  id: string;
  /** Free-form group for the summary table, e.g. "lookup" or "unanswerable". */
  category: string;
  question: string;
  /** "refuse" means the documents don't contain the answer and the model should say so. */
  expect: Expectation;
  /** Verbatim snippets from the documents that retrieval has to surface (whitespace-insensitive). */
  evidence: string[];
  /** Every group must match; a group matches if any of its alternatives appears in the answer. */
  mustInclude: string[][];
  /** None of these may appear in the answer. */
  mustNotInclude: string[];
  /** Require at least one citation, and that a cited passage contains the evidence. */
  mustCite: boolean;
}

export interface EvalDataset {
  name: string;
  /** Absolute path of the documents this dataset asks about. */
  documents: string;
  cases: EvalCase[];
}

/** Loads and validates a dataset file. `documents` is resolved relative to the file. */
export async function loadDataset(file: string): Promise<EvalDataset> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new HearthyError(`Cannot read eval dataset ${file}: ${(err as Error).message}`);
  }
  return parseDataset(raw, path.dirname(path.resolve(file)));
}

export function parseDataset(raw: unknown, baseDir: string): EvalDataset {
  const fail = (message: string): never => {
    throw new HearthyError(`Invalid eval dataset: ${message}`);
  };
  if (!isObject(raw)) return fail('expected a JSON object');
  if (typeof raw.documents !== 'string') return fail('"documents" must be a path');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) return fail('"cases" must be a list');

  const ids = new Set<string>();
  const cases = raw.cases.map((c: unknown, i): EvalCase => {
    if (!isObject(c)) return fail(`case ${i + 1} is not an object`);
    const where = `case "${String(c.id ?? i + 1)}"`;
    if (typeof c.id !== 'string' || !c.id) return fail(`case ${i + 1} needs an "id"`);
    if (ids.has(c.id)) return fail(`duplicate id "${c.id}"`);
    ids.add(c.id);
    if (typeof c.question !== 'string' || !c.question) return fail(`${where} needs a "question"`);
    if (c.expect !== 'answer' && c.expect !== 'refuse') {
      return fail(`${where}: "expect" must be "answer" or "refuse"`);
    }
    const strings = (value: unknown, field: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v)) {
        return fail(`${where}: "${field}" must be a list of strings`);
      }
      return value;
    };
    const mustInclude = (c.mustInclude ?? []) as unknown;
    if (!Array.isArray(mustInclude)) return fail(`${where}: "mustInclude" must be a list`);

    return {
      id: c.id,
      category: typeof c.category === 'string' ? c.category : 'uncategorised',
      question: c.question,
      expect: c.expect,
      evidence: strings(c.evidence, 'evidence'),
      mustInclude: mustInclude.map((group) =>
        strings(typeof group === 'string' ? [group] : group, 'mustInclude'),
      ),
      mustNotInclude: strings(c.mustNotInclude, 'mustNotInclude'),
      mustCite: typeof c.mustCite === 'boolean' ? c.mustCite : c.expect === 'answer',
    };
  });

  return {
    name: typeof raw.name === 'string' ? raw.name : 'eval',
    documents: path.resolve(baseDir, raw.documents),
    cases,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
