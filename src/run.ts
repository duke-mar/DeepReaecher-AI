import * as readline from 'readline';

import { getModel } from './ai/providers.js';
import { deepResearch, writeFinalAnswer, writeFinalReport } from './deep-research.js';
import { generateFeedback } from './feedback.js';
import { getActiveSearchEngines } from './search-engines.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question: string): Promise<string> =>
  new Promise((resolve) => rl.question(question, resolve));

async function main() {
  console.log('Using model: ', getModel().modelId);

  // Display available search engines
  const searchEngines = getActiveSearchEngines();
  if (searchEngines.length > 0) {
    console.log('Available search engines:', searchEngines.join(', '));
  } else {
    console.log('No search engines configured. Using LLM knowledge only.');
  }

  const initialQuery = await ask('What would you like to research? ');
  const breadthStr = await ask('Enter research breadth (default 4): ');
  const depthStr = await ask('Enter research depth (default 2): ');
  const modeStr = await ask('Output mode - report or answer (default report): ');

  const breadth = parseInt(breadthStr) || 4;
  const depth = parseInt(depthStr) || 2;
  const mode = modeStr.trim().toLowerCase() === 'answer' ? 'answer' : 'report';

  let combinedQuery = initialQuery;

  if (mode === 'report') {
    console.log('\nGenerating follow-up questions...\n');
    const followUpQuestions = await generateFeedback({ query: initialQuery });
    const answers: string[] = [];

    for (const q of followUpQuestions) {
      const answer = await ask(`  ${q}\n  > `);
      answers.push(answer);
    }

    combinedQuery = `Initial Query: ${initialQuery}\nFollow-up Questions and Answers:\n${followUpQuestions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join('\n')}`;
  }

  console.log('\nStarting deep research...\n');

  const result = await deepResearch({
    query: combinedQuery,
    breadth,
    depth,
    onProgress: (progress) => {
      const engineInfo = progress.searchEngine ? ` [${progress.searchEngine}]` : '';
      console.log(
        `[Depth ${progress.currentDepth}/${progress.totalDepth}] ` +
          `[Breadth ${progress.currentBreadth}/${progress.totalBreadth}] ` +
          `[${progress.completedQueries}/${progress.totalQueries}] ` +
          `${progress.currentQuery || ''}${engineInfo}`
      );
    },
  });

  console.log(`\nResearch complete. Found ${result.learnings.length} learnings.`);

  let output: string;
  if (mode === 'report') {
    output = await writeFinalReport({
      prompt: combinedQuery,
      learnings: result.learnings,
      visitedUrls: result.visitedUrls,
    });
    const filename = 'report.md';
    const fs = await import('fs');
    fs.writeFileSync(filename, output);
    console.log(`Report saved to ${filename}`);
  } else {
    output = await writeFinalAnswer({
      prompt: combinedQuery,
      learnings: result.learnings,
    });
    const filename = 'answer.md';
    const fs = await import('fs');
    fs.writeFileSync(filename, output);
    console.log(`Answer saved to ${filename}`);
  }

  console.log('\n--- Output ---\n');
  console.log(output);

  rl.close();
}

main().catch(console.error);
