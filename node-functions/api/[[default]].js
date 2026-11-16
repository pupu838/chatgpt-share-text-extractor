import express from 'express';
import { extractionErrorResponse, readSharedConversation } from '../../shared/transcript.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/extract', async (req, res) => {
  try {
    const chat = await readSharedConversation(req.body?.url, req.body);
    res.json({ ok: true, data: chat });
  } catch (error) {
    const { status, body } = extractionErrorResponse(error);
    res.status(status).json(body);
  }
});

app.get('/media', async (req, res) => {
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

export default app;
