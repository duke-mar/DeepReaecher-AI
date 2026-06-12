import { generateObjectCompat, getModel } from './ai/providers.js';
import { systemPrompt } from './prompt.js';

export async function generateFeedback({
  query,
  numQuestions = 3,
}: {
  query: string;
  numQuestions?: number;
}): Promise<string[]> {
  const { object } = await generateObjectCompat<{
    questions: string[];
  }>({
    model: getModel(),
    system: systemPrompt(),
    prompt: `根据用户的查询，提出一些追问以明确研究方向。最多返回 ${numQuestions} 个问题，如果原始查询已经很明确，可以少返回一些：<query>${query}</query>`,
    schemaDescription: `{
  "questions": ["string — 追问，最多 ${numQuestions} 个"]
}`,
  });

  return object.questions.slice(0, numQuestions);
}
