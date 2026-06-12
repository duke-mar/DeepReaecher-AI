import cors from 'cors';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { deepResearch, writeFinalAnswer, writeFinalReport } from './deep-research.js';
import { generateFeedback } from './feedback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3051;

app.use(cors());
app.use(express.json());

// Serve static web files
app.use('/web', express.static(join(__dirname, 'web')));

// Redirect root to web interface
app.get('/', (_req, res) => {
  res.redirect('/web');
});

// --- SSE Research Endpoint ---
app.get('/api/research/stream', async (req, res) => {
  const query = req.query.query as string;
  const breadth = parseInt(req.query.breadth as string) || 3;
  const depth = parseInt(req.query.depth as string) || 3;
  const mode = (req.query.mode as string) === 'answer' ? 'answer' : 'report';

  if (!query) {
    res.status(400).json({ error: 'Query is required' });
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event: string, data: any) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };

  try {
    // Step 1: Generate feedback questions
    sendEvent('status', { phase: 'analyzing', message: 'AI 正在分析问题...' });

    let followUpQuestions: string[] = [];
    try {
      followUpQuestions = await generateFeedback({ query });
    } catch (e: any) {
      console.error('Feedback generation failed:', e.message || e);
      if (e.stack) console.error(e.stack);
      // Continue without feedback rather than crashing
    }

    if (followUpQuestions.length > 0) {
      sendEvent('feedback', { questions: followUpQuestions });
    }

    // Step 2: Start research
    sendEvent('status', { phase: 'researching', message: '深度研究进行中...' });

    const result = await deepResearch({
      query,
      breadth,
      depth,
      onProgress: (progress) => {
        sendEvent('progress', progress);
      },
    });

    sendEvent('status', { phase: 'generating', message: 'AI 正在生成报告...' });

    // Step 3: Generate output
    let output: string;
    if (mode === 'report') {
      output = await writeFinalReport({
        prompt: query,
        learnings: result.learnings,
        visitedUrls: result.visitedUrls,
      });
    } else {
      output = await writeFinalAnswer({
        prompt: query,
        learnings: result.learnings,
      });
    }

    sendEvent('complete', {
      output,
      learnings: result.learnings,
      visitedUrls: result.visitedUrls,
      mode,
    });
  } catch (error: any) {
    console.error('Research failed:', error);
    sendEvent('error', { message: error.message || '研究过程出错' });
  } finally {
    try {
      res.end();
    } catch {
      // Already ended
    }
  }
});

// --- REST API Endpoints ---
app.post('/api/research', async (req, res) => {
  const { query, depth = 3, breadth = 3 } = req.body;

  if (!query) {
    res.status(400).json({ error: 'Query is required' });
    return;
  }

  try {
    const result = await deepResearch({ query, breadth, depth });
    const answer = await writeFinalAnswer({ prompt: query, learnings: result.learnings });

    res.json({
      success: true,
      answer,
      learnings: result.learnings,
      visitedUrls: result.visitedUrls,
    });
  } catch (error: any) {
    console.error('Research API failed:', error);
    res.status(500).json({ error: error.message, message: 'Research failed' });
  }
});

app.post('/api/generate-report', async (req, res) => {
  const { query, depth = 3, breadth = 3 } = req.body;

  try {
    const result = await deepResearch({ query, breadth, depth });
    const report = await writeFinalReport({
      prompt: query,
      learnings: result.learnings,
      visitedUrls: result.visitedUrls,
    });

    res.json({ success: true, report });
  } catch (error: any) {
    console.error('Report generation failed:', error);
    res.status(500).json({ error: error.message, message: 'Report generation failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Deep Research API server running on http://localhost:${PORT}`);
  console.log(`Web interface: http://localhost:${PORT}/web`);
});
