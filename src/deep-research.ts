import { compact } from 'lodash-es';
import pLimit from 'p-limit';

import { generateObjectCompat, getModel, trimPrompt } from './ai/providers.js';
import { systemPrompt } from './prompt.js';
import { searchWithFallback, SearchEngine } from './search-engines.js';

// --- Types ---
export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
  searchStatus?: 'searching' | 'success' | 'failed';
  searchUrl?: string;
  searchEngine?: SearchEngine;
};

export type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// --- Config ---
const ConcurrencyLimit = Number(process.env.FIRECRAWL_CONCURRENCY) || 2;

// --- Helpers ---
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;
  learnings?: string[];
}): Promise<{ query: string; researchGoal: string }[]> {
  const prompt = `根据用户提出的问题，生成一组搜索查询来研究该主题。最多返回 ${numQueries} 个查询，如果原始问题已经很明确，可以少返回一些。确保每个查询都是独特的，彼此不相似：<prompt>${query}</prompt>${
    learnings?.length
      ? `\n\n以下是之前研究的一些发现，请利用它们生成更具体的查询：\n${learnings.join('\n')}`
      : ''
  }`;

  const { object } = await generateObjectCompat<{
    queries: { query: string; researchGoal: string }[];
  }>({
    model: getModel(),
    system: systemPrompt(),
    prompt,
    schemaDescription: `{
  "queries": [
    {
      "query": "string — 搜索查询关键词",
      "researchGoal": "string — 首先解释研究目标，然后描述后续研究方向及原因"
    }
  ]
}`,
  });

  return object.queries;
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: { data: { url: string; markdown?: string }[] };
  numLearnings?: number;
  numFollowUpQuestions?: number;
}): Promise<{ learnings: string[]; followUpQuestions: string[] }> {
  const contents = compact(
    result.data.map((item) => item.markdown).map((c) => (c ? c.trim() : null))
  ).map((c) => trimPrompt(c, 25_000));

  const prompt = `根据以下针对查询 <query>${query}</query> 的 SERP 搜索结果内容，从中提取学习要点。最多返回 ${numLearnings} 个要点，如果信息充足可以少返回一些。确保每个要点都是独特的，彼此不相似。同时，生成可用于进一步研究该主题的追问。将追问与学习要点返回在同一数组中，追问前加上"追问："前缀。追问编号为 ${numLearnings + 1} 到 ${numLearnings + numFollowUpQuestions}。每个学习要点应简洁且信息密集，尽可能包含实体、精确指标、数字、日期等。不要在学习要点中包含追问。

<contents>
${contents.map((c) => `<content>\n${c}\n</content>`).join('\n')}
</contents>`;

  const trimmedPrompt = trimPrompt(prompt);

  const { object } = await generateObjectCompat<{
    learnings: string[];
    followUpQuestions: string[];
  }>({
    model: getModel(),
    system: systemPrompt(),
    prompt: trimmedPrompt,
    schemaDescription: `{
  "learnings": ["string — 最多 ${numLearnings} 个学习要点，每个简洁且信息密集"],
  "followUpQuestions": ["string — 最多 ${numFollowUpQuestions} 个追问"]
}`,
    abortSignal: AbortSignal.timeout(60_000),
  });

  return object;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<ResearchResult> {
  const limit = pLimit(ConcurrencyLimit);

  // Generate search queries for this depth level
  const queries = await generateSerpQueries({
    query,
    numQueries: breadth,
    learnings: learnings.length > 0 ? learnings : undefined,
  });

  let totalQueries = queries.length;
  let completedQueries = 0;
  const queryStatusMap = new Map<string, 'searching' | 'success' | 'failed'>();

  const reportProgress = (currentQuery: string, searchStatus?: 'searching' | 'success' | 'failed', searchUrl?: string, searchEngine?: SearchEngine) => {
    // Update status map
    if (searchStatus) {
      queryStatusMap.set(currentQuery, searchStatus);
    }

    // Count completed queries (success or failed)
    let completedCount = 0;
    for (const status of queryStatusMap.values()) {
      if (status === 'success' || status === 'failed') {
        completedCount++;
      }
    }
    completedQueries = completedCount;

    onProgress?.({
      currentDepth: depth,
      totalDepth: depth,
      currentBreadth: breadth,
      totalBreadth: breadth,
      currentQuery,
      totalQueries,
      completedQueries,
      searchStatus,
      searchUrl,
      searchEngine,
    });
  };

  const results = await Promise.all(
    queries.map((q) =>
      limit(async () => {
        try {
          reportProgress(q.query, 'searching');

          let result;
          let lastStatus: 'success' | 'failed' = 'success';
          let usedEngine: SearchEngine = 'none';

          try {
            const searchResponse = await searchWithFallback(q.query, {
              limit: 5,
              timeout: 15000,
              onStatusChange: (engine, status) => {
                reportProgress(q.query, status, undefined, engine);
              },
            });

            result = searchResponse.result;
            usedEngine = searchResponse.engine;

            if (searchResponse.engine === 'none') {
              // All search engines failed
              lastStatus = 'failed';
              reportProgress(q.query, 'failed', undefined, 'none');
              throw new Error('All search engines failed');
            }

            lastStatus = 'success';
            reportProgress(q.query, 'success', undefined, usedEngine);
          } catch (searchError: any) {
            lastStatus = 'failed';
            reportProgress(q.query, 'failed', undefined, usedEngine);
            throw searchError;
          }

          const urls = compact(result.data.map((item) => item.url));

          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const { learnings: newLearnings, followUpQuestions } =
            await processSerpResult({
              query: q.query,
              result: result as any,
              numFollowUpQuestions: newBreadth,
            });

          reportProgress(q.query, lastStatus, undefined, usedEngine);

          let deepResult: ResearchResult = {
            learnings: newLearnings,
            visitedUrls: urls,
          };

          if (newDepth > 0) {
            const nextQuery = `Previous research goal: ${q.researchGoal}\nFollow-up research directions:\n${followUpQuestions.join('\n')}`;
            const subResult = await deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: [...learnings, ...newLearnings],
              visitedUrls: [...visitedUrls, ...urls],
              onProgress,
            });
            deepResult = {
              learnings: [...newLearnings, ...subResult.learnings],
              visitedUrls: [...urls, ...subResult.visitedUrls],
            };
          }

          return deepResult;
        } catch (e: any) {
          reportProgress(q.query, 'failed', undefined, 'none');
          if (e.name === 'TimeoutError') {
            console.error(`Timeout for query: ${q.query}`);
          } else {
            console.error(`Error for query: ${q.query}`, e);
          }
          return { learnings: [], visitedUrls: [] } as ResearchResult;
        }
      })
    )
  );

  // Deduplicate
  return {
    learnings: [...new Set(results.flatMap((r) => r.learnings))],
    visitedUrls: [...new Set(results.flatMap((r) => r.visitedUrls))],
  };
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}): Promise<string> {
  const learningsString = learnings
    .map((l) => `<learning>\n${l}\n</learning>`)
    .join('\n');

  const { object } = await generateObjectCompat<{
    reportMarkdown: string;
  }>({
    model: getModel(),
    system: systemPrompt(),
    prompt: `根据用户提出的问题，结合研究中获得的所有学习要点，撰写一份最终研究报告。尽可能详细，目标是3页以上，包含研究中的所有学习要点：

<prompt>${prompt}</prompt>

以下是之前研究的所有学习要点：

<learnings>
${learningsString}
</learnings>`,
    schemaDescription: `{
  "reportMarkdown": "string — 主题的最终研究报告，Markdown格式，详细，3页以上"
}`,
  });

  const sourcesSection =
    visitedUrls.length > 0
      ? `\n\n## 来源\n\n${visitedUrls.map((url) => `- ${url}`).join('\n')}`
      : '';

  return object.reportMarkdown + sourcesSection;
}

export async function writeFinalAnswer({
  prompt,
  learnings,
}: {
  prompt: string;
  learnings: string[];
}): Promise<string> {
  const learningsString = learnings
    .map((l) => `<learning>\n${l}\n</learning>`)
    .join('\n');

  const { object } = await generateObjectCompat<{
    exactAnswer: string;
  }>({
    model: getModel(),
    system: systemPrompt(),
    prompt: `根据用户提出的问题，结合研究中获得的所有学习要点，撰写一个最终答案。遵循提示中指定的格式。不要啰嗦，直奔主题。答案尽可能简洁——通常只需几个字或最多一句话。尽量遵循提示中指定的格式（例如，如果提示使用LaTeX，答案也应使用LaTeX...）

<prompt>${prompt}</prompt>

以下是之前研究的所有学习要点：

<learnings>
${learningsString}
</learnings>`,
    schemaDescription: `{
  "exactAnswer": "string — 最终答案，简短精炼，仅包含答案，不含其他文字"
}`,
  });

  return object.exactAnswer;
}
