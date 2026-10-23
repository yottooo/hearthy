import { describe, expect, it } from 'vitest';
import { HearthyError } from '../src/errors.js';
import { type EvalCase, parseDataset } from '../src/eval/dataset.js';
import { containsTerm, isRefusal, scoreAnswer, scoreRetrieval } from '../src/eval/scoring.js';
import type { RetrievedChunk } from '../src/rag/retrieve.js';

const chunk = (content: string): RetrievedChunk => ({
  path: '/docs/a.md',
  ord: 0,
  content,
  score: 0.5,
});

const baseCase: EvalCase = {
  id: 'e4',
  category: 'lookup',
  question: 'What does E4 mean?',
  expect: 'answer',
  evidence: ['Dry-boil protection triggered'],
  mustInclude: [['empty', 'dry']],
  mustNotInclude: [],
  mustCite: true,
};

const chunks = [
  chunk('## Warranty\nThe K2 has a 3-year warranty.'),
  chunk('| E4 | Dry-boil   protection\ntriggered | The kettle is empty. |'),
];

describe('containsTerm', () => {
  it('matches case- and whitespace-insensitively', () => {
    expect(containsTerm('Core hours are 10:00 to\n15:00', '10:00 TO 15:00')).toBe(true);
  });

  it('respects word boundaries for alphanumeric terms', () => {
    expect(containsTerm('25 days of holiday', '5')).toBe(false);
    expect(containsTerm('up to 5 days', '5')).toBe(true);
    expect(containsTerm('error E45', 'E4')).toBe(false);
    expect(containsTerm('costs 70°C', '°C')).toBe(true);
  });
});

describe('scoreRetrieval', () => {
  it('ranks each evidence snippet by the first chunk that contains it', () => {
    expect(scoreRetrieval(baseCase, chunks)).toEqual({
      ranks: [2],
      hit: true,
      reciprocalRank: 0.5,
    });
  });

  it('reports a miss, and is null when there is no evidence to find', () => {
    expect(scoreRetrieval({ ...baseCase, evidence: ['Firmware'] }, chunks)).toMatchObject({
      hit: false,
      reciprocalRank: 0,
    });
    expect(scoreRetrieval({ ...baseCase, evidence: [] }, chunks)).toBeNull();
  });
});

describe('isRefusal', () => {
  it.each([
    'I could not find the answer in the provided documents.',
    "I couldn't find that in the documents.",
    "I can't determine that from the passages.",
    'The price is not mentioned in the context.',
    "The documents don't mention the number of employees.",
    'There is no error code E6 in the manual.',
  ])('recognises "%s"', (answer) => {
    expect(isRefusal(answer)).toBe(true);
  });

  it('does not flag a real answer', () => {
    expect(isRefusal('E4 means the kettle is empty [1].')).toBe(false);
  });
});

describe('scoreAnswer', () => {
  it('passes a correct answer that cites the passage with the evidence', () => {
    expect(scoreAnswer(baseCase, 'The kettle is empty [2].', new Set([2]), chunks)).toEqual({
      pass: true,
      failures: [],
    });
  });

  it('fails a correct answer that cites the wrong passage', () => {
    const score = scoreAnswer(baseCase, 'The kettle is empty [1].', new Set([1]), chunks);
    expect(score.pass).toBe(false);
    expect(score.failures).toEqual(['cites [1], not the passage with the answer']);
  });

  it('reports missing terms and uncited answers', () => {
    expect(scoreAnswer(baseCase, 'It means a fault.', new Set(), chunks).failures).toEqual([
      'missing "empty" or "dry"',
      'cites no passages',
    ]);
  });

  it('expects a refusal for unanswerable questions, and no forbidden terms', () => {
    const refuse: EvalCase = {
      ...baseCase,
      expect: 'refuse',
      evidence: [],
      mustInclude: [],
      mustNotInclude: ['Paris'],
      mustCite: false,
    };
    expect(scoreAnswer(refuse, 'I could not find that.', new Set(), chunks).pass).toBe(true);
    expect(scoreAnswer(refuse, 'The capital is Paris.', new Set(), chunks).failures).toEqual([
      'answered instead of saying the documents do not cover it',
      'should not mention "Paris"',
    ]);
  });
});

describe('parseDataset', () => {
  it('fills defaults and resolves documents relative to the dataset', () => {
    const dataset = parseDataset(
      {
        documents: 'docs',
        cases: [
          { id: 'a', question: 'Q?', expect: 'answer', mustInclude: ['x', ['y', 'z']] },
          { id: 'b', question: 'Q?', expect: 'refuse' },
        ],
      },
      '/base',
    );
    expect(dataset.documents.replaceAll('\\', '/')).toMatch(/\/base\/docs$/);
    expect(dataset.cases[0]).toMatchObject({
      category: 'uncategorised',
      evidence: [],
      mustInclude: [['x'], ['y', 'z']],
      mustCite: true,
    });
    expect(dataset.cases[1]!.mustCite).toBe(false);
  });

  it('rejects malformed cases with a clear message', () => {
    const parse = (cases: unknown[]) => () => parseDataset({ documents: 'd', cases }, '/');
    expect(parse([{ id: 'a', question: 'Q', expect: 'maybe' }])).toThrow(/"expect" must be/);
    expect(
      parse([
        { id: 'a', question: 'Q', expect: 'answer' },
        { id: 'a', question: 'Q', expect: 'answer' },
      ]),
    ).toThrow(/duplicate id "a"/);
    expect(parse([{ id: 'a', question: 'Q', expect: 'answer', evidence: [1] }])).toThrow(
      HearthyError,
    );
  });
});
