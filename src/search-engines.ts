import FirecrawlApp from '@mendable/firecrawl-js';

// --- Types ---
export type SearchResult = {
  data: { url: string; markdown?: string }[];
};

export type SearchEngine = 'firecrawl' | 'metaso' | 'none';

// --- Firecrawl Instance ---
const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_KEY ?? '',
  apiUrl: process.env.FIRECRAWL_BASE_URL,
});

// --- Metaso Search ---
async function searchWithMetaso(
  query: string,
  options: { limit?: number; timeout?: number } = {}
): Promise<SearchResult> {
  const { limit = 5, timeout = 15000 } = options;

  const apiUrl = process.env.SEARCH_ENGINE_API_URL_1;
  const apiKey = process.env.SEARCH_ENGINE_API_KEY_1;

  if (!apiUrl || !apiKey) {
    throw new Error('Metaso API not configured');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        scope: 'webpage',
        includeSummary: false,
        size: limit.toString(),
        includeRawContent: false,
        conciseSnippet: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Metaso API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Check if we have results
    if (!data.webpages || !Array.isArray(data.webpages) || data.webpages.length === 0) {
      throw new Error('No results from Metaso');
    }

    // Convert to common format
    // Metaso returns snippets, not full markdown content
    // We'll use the snippet as markdown content
    return {
      data: data.webpages.slice(0, limit).map((item: any) => ({
        url: item.link,
        // Format snippet with metadata for better context
        markdown: formatMetasoSnippet(item),
      })),
    };
  } catch (error: any) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error('Metaso search timeout');
    }
    throw error;
  }
}

function formatMetasoSnippet(item: any): string {
  const parts: string[] = [];

  if (item.title) {
    parts.push(`## ${item.title}`);
  }

  if (item.snippet) {
    parts.push(item.snippet);
  }

  if (item.date) {
    parts.push(`\n*发布日期: ${item.date}*`);
  }

  if (item.authors && item.authors.length > 0) {
    parts.push(`*作者: ${item.authors.join(', ')}*`);
  }

  return parts.join('\n\n');
}

// --- Main Search Function with Fallback ---
export async function searchWithFallback(
  query: string,
  options: {
    limit?: number;
    timeout?: number;
    onStatusChange?: (engine: SearchEngine, status: 'searching' | 'success' | 'failed') => void;
  } = {}
): Promise<{ result: SearchResult; engine: SearchEngine }> {
  const { limit = 5, timeout = 15000, onStatusChange } = options;

  console.log(`[Search] Starting search for: "${query.substring(0, 50)}..."`);

  // 1. Try Firecrawl first
  if (process.env.FIRECRAWL_KEY) {
    console.log('[Search] Trying Firecrawl...');
    onStatusChange?.('firecrawl', 'searching');
    try {
      const result = await firecrawl.search(query, {
        timeout,
        limit,
        scrapeOptions: { formats: ['markdown'] },
      });

      // Check if we got meaningful content
      const hasContent = result.data?.some(
        (item) => item.markdown && item.markdown.trim().length > 0
      );

      if (hasContent) {
        console.log('[Search] Firecrawl succeeded');
        onStatusChange?.('firecrawl', 'success');
        return { result: result as SearchResult, engine: 'firecrawl' };
      }

      // Firecrawl returned but no content - treat as failed
      console.log('[Search] Firecrawl returned empty content');
      onStatusChange?.('firecrawl', 'failed');
    } catch (error: any) {
      console.log(`[Search] Firecrawl failed: ${error.message}`);
      onStatusChange?.('firecrawl', 'failed');
    }
  } else {
    console.log('[Search] Firecrawl not configured, skipping...');
  }

  // 2. Try Metaso as fallback
  console.log('[Search] Checking Metaso config...', {
    url: process.env.SEARCH_ENGINE_API_URL_1 ? 'set' : 'not set',
    key: process.env.SEARCH_ENGINE_API_KEY_1 ? 'set' : 'not set',
  });

  if (process.env.SEARCH_ENGINE_API_URL_1 && process.env.SEARCH_ENGINE_API_KEY_1) {
    console.log('[Search] Trying Metaso...');
    onStatusChange?.('metaso', 'searching');
    try {
      const result = await searchWithMetaso(query, { limit, timeout });
      console.log('[Search] Metaso succeeded');
      onStatusChange?.('metaso', 'success');
      return { result, engine: 'metaso' };
    } catch (error: any) {
      console.log(`[Search] Metaso failed: ${error.message}`);
      onStatusChange?.('metaso', 'failed');
    }
  } else {
    console.log('[Search] Metaso not configured');
  }

  // 3. All search engines failed
  console.log('[Search] All search engines failed, returning empty result');
  onStatusChange?.('none', 'failed');
  return { result: { data: [] }, engine: 'none' };
}

// --- Helper to check if search is available ---
export function isSearchAvailable(): boolean {
  return !!(process.env.FIRECRAWL_KEY || process.env.SEARCH_ENGINE_API_URL_1);
}

// --- Get active search engines info ---
export function getActiveSearchEngines(): SearchEngine[] {
  const engines: SearchEngine[] = [];

  if (process.env.FIRECRAWL_KEY) {
    engines.push('firecrawl');
  }

  if (process.env.SEARCH_ENGINE_API_URL_1 && process.env.SEARCH_ENGINE_API_KEY_1) {
    engines.push('metaso');
  }

  return engines;
}
