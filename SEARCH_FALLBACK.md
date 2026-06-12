# 搜索引擎降级方案

## 概述

本项目实现了搜索引擎降级机制，当主搜索引擎（Firecrawl）失败时，自动切换到备用搜索引擎，最终降级到使用 LLM 内置知识生成报告。

## 降级策略

```
Firecrawl (优先) → Metaso (备用) → LLM 内置知识 (兜底)
```

触发降级的条件：
1. HTTP 请求错误
2. 请求超时
3. 返回空结果（无有效内容）

## 配置

在 `.env` 或 `.env.local` 中添加：

```env
# 主搜索引擎 - Firecrawl
FIRECRAWL_KEY=your_firecrawl_key
FIRECRAWL_BASE_URL=  # 可选，留空使用官方 SaaS

# 备用搜索引擎 - Metaso（可选）
SEARCH_ENGINE_API_URL_1=https://metaso.cn/api/v1/search
SEARCH_ENGINE_API_KEY_1=your_metaso_key

# 可扩展更多备用引擎（预留）
# SEARCH_ENGINE_API_URL_2=...
# SEARCH_ENGINE_API_KEY_2=...
```

## 支持的搜索引擎

### 1. Firecrawl（主搜索引擎）
- 官网：https://firecrawl.dev/
- 返回完整页面内容（markdown 格式）
- 内容更丰富，适合深度研究

### 2. Metaso（备用搜索引擎）
- 官网：https://metaso.cn/
- 返回搜索结果摘要片段
- 响应更快，适合快速信息检索

## 技术实现

### 核心文件

- `src/search-engines.ts` - 搜索引擎适配器，封装各引擎调用
- `src/deep-research.ts` - 主研究逻辑，集成降级机制
- `src/run.ts` - CLI 入口，显示搜索引擎状态

### 降级流程

```typescript
// search-engines.ts
export async function searchWithFallback(query, options) {
  // 1. 尝试 Firecrawl
  if (FIRECRAWL_KEY) {
    try {
      return await searchWithFirecrawl(query);
    } catch (error) {
      console.log('Firecrawl failed, trying fallback...');
    }
  }

  // 2. 尝试 Metaso
  if (SEARCH_ENGINE_API_URL_1 && SEARCH_ENGINE_API_KEY_1) {
    try {
      return await searchWithMetaso(query);
    } catch (error) {
      console.log('Metaso failed');
    }
  }

  // 3. 返回空结果，让 LLM 使用内置知识
  return { result: { data: [] }, engine: 'none' };
}
```

### 进度回调

研究进度现在包含 `searchEngine` 字段，显示当前使用的搜索引擎：

```typescript
type ResearchProgress = {
  // ... 其他字段
  searchEngine?: 'firecrawl' | 'metaso' | 'none';
};
```

CLI 输出示例：
```
[Depth 1/2] [Breadth 4/4] [1/4] agent架构 [firecrawl]
[Depth 1/2] [Breadth 4/4] [2/4] AI agent原理 [metaso]
```

## 扩展新搜索引擎

要添加新的备用搜索引擎，在 `src/search-engines.ts` 中：

1. 添加配置环境变量
2. 实现新的搜索函数
3. 在 `searchWithFallback` 中添加降级逻辑

示例（添加 SerpAPI）：

```typescript
async function searchWithSerpApi(query: string, options: { limit?: number }) {
  const apiUrl = process.env.SEARCH_ENGINE_API_URL_2;
  const apiKey = process.env.SEARCH_ENGINE_API_KEY_2;

  if (!apiUrl || !apiKey) {
    throw new Error('SerpAPI not configured');
  }

  const response = await fetch(`${apiUrl}?api_key=${apiKey}&q=${query}&num=${options.limit}`);
  const data = await response.json();

  return {
    data: data.organic_results.map((item: any) => ({
      url: item.link,
      markdown: `${item.title}\n\n${item.snippet}`,
    })),
  };
}
```

然后在 `searchWithFallback` 中添加：

```typescript
// 2.5 尝试 SerpAPI
if (process.env.SEARCH_ENGINE_API_URL_2 && process.env.SEARCH_ENGINE_API_KEY_2) {
  try {
    const result = await searchWithSerpApi(query, { limit });
    return { result, engine: 'serpapi' };
  } catch (error) {
    console.log('SerpAPI failed');
  }
}
```

## 注意事项

1. **内容差异**：Firecrawl 返回完整页面，Metaso 只返回摘要。降级后内容深度会降低。

2. **成本考虑**：Firecrawl 按页面计费，Metaso 按搜索次数计费。根据使用场景选择。

3. **API 限制**：注意各搜索引擎的 QPS 和配额限制。

4. **错误处理**：所有搜索引擎失败时，LLM 会基于内置知识生成报告，但内容可能不够准确或最新。

## 测试

运行以下命令测试降级机制：

```bash
# 只配置 Firecrawl
FIRECRAWL_KEY=xxx npm start

# 只配置 Metaso
SEARCH_ENGINE_API_URL_1=https://metaso.cn/api/v1/search
SEARCH_ENGINE_API_KEY_1=xxx
npm start

# 配置两者（测试降级）
npm start
```
