import type { Message } from 'ollama';
import type { LocalModels } from '../llm/ollama.js';
import type { RetrievedChunk } from '../rag/retrieve.js';

export interface Verdict {
  faithful: boolean;
  reason: string;
}

const JUDGE_PROMPT = `You grade answers produced by a document question-answering assistant.

You get numbered passages, a question, and the assistant's answer. Decide whether the answer is
FAITHFUL: every factual claim in it is supported by the passages. Saying that the passages do not
contain the answer counts as faithful. Ignore style, length and citation formatting.

Reply with JSON: {"faithful": true|false, "reason": "<one short sentence>"}.`;

const SCHEMA = {
  type: 'object',
  properties: { faithful: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['faithful', 'reason'],
};

/**
 * LLM-as-judge for faithfulness: catches invented details that keyword checks can't see.
 * A judge the same size as the model it grades is noisy, so treat this as a second opinion.
 */
export async function judgeFaithfulness(
  judge: LocalModels,
  question: string,
  chunks: RetrievedChunk[],
  answer: string,
): Promise<Verdict> {
  const passages = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');
  const messages: Message[] = [
    { role: 'system', content: JUDGE_PROMPT },
    {
      role: 'user',
      content: `Passages:\n\n${passages}\n\nQuestion: ${question}\n\nAnswer to grade:\n${answer}`,
    },
  ];
  return judge.completeJson<Verdict>(messages, SCHEMA);
}
