import { createOpenAI, openai } from '@ai-sdk/openai';
import { createFireworks } from '@ai-sdk/fireworks';
import { extractReasoningMiddleware, generateText, wrapLanguageModel } from 'ai';
import { encodingForModel } from 'js-tiktoken';

import { RecursiveCharacterTextSplitter } from './text-splitter.js';

export function getModel() {
  // Priority 1: Custom model via OpenAI-compatible endpoint
  if (process.env.CUSTOM_MODEL && process.env.OPENAI_KEY) {
    const customOpenAI = createOpenAI({
      apiKey: process.env.OPENAI_KEY,
      baseURL: process.env.OPENAI_ENDPOINT || undefined,
    });
    // Don't use structuredOutputs for reasoning models — they return
    // reasoning_content separately and may not support json_schema format.
    // Use default JSON mode instead.
    return customOpenAI(process.env.CUSTOM_MODEL);
  }

  // Priority 2: Fireworks DeepSeek R1
  if (process.env.FIREWORKS_KEY) {
    const fireworks = createFireworks({ apiKey: process.env.FIREWORKS_KEY });
    const baseModel = fireworks('accounts/fireworks/models/deepseek-r1');
    return wrapLanguageModel({
      model: baseModel,
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    });
  }

  // Priority 3: OpenAI o3-mini
  if (process.env.OPENAI_KEY) {
    return openai('o3-mini', {
      reasoningEffort: 'medium',
      structuredOutputs: true,
    });
  }

  throw new Error(
    'No LLM provider available. Set OPENAI_KEY or FIREWORKS_KEY environment variables.'
  );
}

/**
 * generateObject 的兼容替代方案，使用 generateText + JSON 解析。
 * 适用于不支持 structured output / tool calling 的模型。
 */
export async function generateObjectCompat<T>({
  model,
  system,
  prompt,
  schemaDescription,
  abortSignal,
}: {
  model: ReturnType<typeof getModel>;
  system: string;
  prompt: string;
  schemaDescription: string;
  abortSignal?: AbortSignal;
}): Promise<{ object: T }> {
  const fullPrompt = `${prompt}

IMPORTANT: You MUST respond with ONLY a valid JSON object, no markdown, no explanation, no code fences.
The JSON must match this structure exactly:
${schemaDescription}`;

  const { text } = await generateText({
    model,
    system,
    prompt: fullPrompt,
    abortSignal,
  });

  // Extract JSON from response — try to find JSON block in the text
  let jsonStr = text.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find JSON object or array in the text
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const jsonMatch = jsonStr.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
  }

  // Remove BOM and leading/trailing invisible characters
  jsonStr = jsonStr.replace(/^﻿/, '').trim();

  // Clean control characters in JSON strings
  // This fixes issues where LLM returns unescaped newlines in JSON string values
  jsonStr = jsonStr.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (char) => {
    const code = char.charCodeAt(0);
    // Keep \n and \r but escape them properly
    if (code === 10) return '\\n'; // newline
    if (code === 13) return '\\r'; // carriage return
    if (code === 9) return '\\t';  // tab
    // Remove other control characters
    return '';
  });

  try {
    const parsed = JSON.parse(jsonStr) as T;
    return { object: parsed };
  } catch (e) {
    // Try to fix common JSON issues
    try {
      // Fix trailing commas before } or ]
      let fixedJson = jsonStr.replace(/,\s*([\]}])/g, '$1');
      // Fix missing quotes around keys
      fixedJson = fixedJson.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
      const parsed = JSON.parse(fixedJson) as T;
      return { object: parsed };
    } catch {
      throw new Error(
        `Failed to parse model response as JSON: ${(e as Error).message}\nRaw response: ${text.slice(0, 500)}`
      );
    }
  }
}

export function trimPrompt(prompt: string, contextSize = 128_000): string {
  const encoder = encodingForModel('gpt-4o');
  const tokens = encoder.encode(prompt);

  if (tokens.length <= contextSize) {
    return prompt;
  }

  const overflowTokens = tokens.length - contextSize;
  const chunkSize = Math.max(prompt.length - overflowTokens * 3, 140);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: 0,
  });

  // Take first N chunks that fit within context
  return prompt.slice(0, contextSize * 3);
}
