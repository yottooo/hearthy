import type { RetrievedChunk } from '../rag/retrieve.js';
import type { EvalCase } from './dataset.js';

export interface RetrievalScore {
  /** 1-based rank of the first chunk containing each evidence snippet, or null if not retrieved. */
  ranks: (number | null)[];
  /** True when every evidence snippet was retrieved. */
  hit: boolean;
  /** 1 / rank of the first evidence snippet (0 if missed); averaged over cases this is MRR. */
  reciprocalRank: number;
}

export interface AnswerScore {
  pass: boolean;
  /** Human-readable reasons the answer failed; empty when it passed. */
  failures: string[];
}

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Case-insensitive phrase match that won't find "5" inside "25" or "E4" inside "E45". */
export function containsTerm(text: string, term: string): boolean {
  const escaped = normalise(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = /^\w/.test(term) ? '(?<!\\w)' : '';
  const end = /\w$/.test(term) ? '(?!\\w)' : '';
  return new RegExp(start + escaped + end).test(normalise(text));
}

/** Null when the case lists no evidence (e.g. unanswerable questions), since there's nothing to find. */
export function scoreRetrieval(c: EvalCase, chunks: RetrievedChunk[]): RetrievalScore | null {
  if (c.evidence.length === 0) return null;
  const ranks = c.evidence.map((snippet) => {
    const index = chunks.findIndex((chunk) =>
      normalise(chunk.content).includes(normalise(snippet)),
    );
    return index === -1 ? null : index + 1;
  });
  const first = ranks[0];
  return {
    ranks,
    hit: ranks.every((r) => r !== null),
    reciprocalRank: first ? 1 / first : 0,
  };
}

const REFUSAL = new RegExp(
  [
    String.raw`\b(could(n['’]t| not)|cannot|can['’]t|can not|unable to|did(n['’]t| not)) (find|locate|answer|determine)\b`,
    String.raw`\bno (information|mention|details?|data|such)\b`,
    String.raw`\bthere (is|are) no\b`,
    String.raw`\bnot (mentioned|found|provided|included|specified|stated|covered|available|listed)\b`,
    String.raw`\b(does|do)(n['’]t| not) (contain|mention|say|provide|include|specify|state|cover|have)\b`,
  ].join('|'),
  'i',
);

/** Heuristic for "the documents don't say": the expected reply to an unanswerable question. */
export function isRefusal(answer: string): boolean {
  return REFUSAL.test(answer);
}

export function scoreAnswer(
  c: EvalCase,
  answer: string,
  cited: Set<number>,
  chunks: RetrievedChunk[],
): AnswerScore {
  const failures: string[] = [];

  if (c.expect === 'refuse' && !isRefusal(answer)) {
    failures.push('answered instead of saying the documents do not cover it');
  }
  for (const group of c.mustInclude) {
    if (!group.some((term) => containsTerm(answer, term))) {
      failures.push(`missing ${group.map((t) => `"${t}"`).join(' or ')}`);
    }
  }
  for (const term of c.mustNotInclude) {
    if (containsTerm(answer, term)) failures.push(`should not mention "${term}"`);
  }
  if (c.mustCite) {
    if (cited.size === 0) {
      failures.push('cites no passages');
    } else if (c.evidence.length > 0) {
      const citedText = [...cited].map((n) => normalise(chunks[n - 1]?.content ?? ''));
      const citesEvidence = c.evidence.some((snippet) =>
        citedText.some((text) => text.includes(normalise(snippet))),
      );
      if (!citesEvidence) {
        failures.push(`cites [${[...cited].join('][')}], not the passage with the answer`);
      }
    }
  }

  return { pass: failures.length === 0, failures };
}
