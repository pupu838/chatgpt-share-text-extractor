import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractionErrorResponse, readSharedConversation } from './shared/transcript.js';


const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const buckets = new Map();

function rateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    buckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > MAX_REQUESTS) {
    return res.status(429).json({
      ok: false,
      code: 'local_rate_limit',
      error: '请求太频繁，请稍后再试。'
    });
  }
  next();
}

app.post('/api/extract', rateLimit, async (req, res) => {
  try {
    const chat = await readSharedConversation(req.body?.url, req.body);
    res.json({ ok: true, data: chat });
  } catch (error) {
    const { status, body } = extractionErrorResponse(error);
    res.status(status).json(body);
  }
});

app.get('/api/media', rateLimit, async (req, res) => {
  try {
    const target = new URL(String(req.query?.url || ''));
    const host = target.hostname.toLowerCase();
    const allowed = host === 'chatgpt.com' || host === 'cdn.openai.com' || host.endsWith('.oaiusercontent.com') || host.endsWith('.oaistatic.com');
    if (target.protocol !== 'https:' || !allowed) return res.status(400).json({ ok: false, error: '不支持该媒体地址。' });
    const upstream = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,video/*' } });
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || (!type.startsWith('image/') && !type.startsWith('video/'))) return res.status(404).end();
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(404).end();
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ChatGPT share text extractor: http://localhost:${PORT}`);
});
