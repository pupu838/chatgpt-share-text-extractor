import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSharedConversation } from './shared/transcript.js';


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

function normalizeShareUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('请输入 ChatGPT 分享链接。'), { code: 'invalid_url' });
  }

  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error('链接格式无效。'), { code: 'invalid_url' });
  }

  const host = url.hostname.toLowerCase();
  const allowed = host === 'chatgpt.com' || host === 'www.chatgpt.com' || host === 'chat.openai.com';
  if (!allowed) {
    throw Object.assign(new Error('只支持 ChatGPT 的公开分享链接。'), { code: 'unsupported_host' });
  }
  if (!url.pathname.startsWith('/share/')) {
    throw Object.assign(new Error('这不是公开分享链接。请使用形如 https://chatgpt.com/share/... 的地址。'), { code: 'not_a_share_link' });
  }

  url.hash = '';
  return url.toString();
}


function friendlyError(err) {
  const code = err?.code || 'extract_failed';
  const raw = String(err?.message || '提取失败。');

  const map = {
    invalid_url: '链接格式无效。',
    unsupported_host: '只支持 ChatGPT 的分享链接。',
    not_a_share_link: '该地址不是 ChatGPT 公开分享链接。',
    not_found: '没有找到该分享页面，链接可能已失效或被删除。',
    not_public: '该对话当前无法公开访问，可能需要登录或属于受限工作区。',
    rate_limited: 'ChatGPT 暂时限制了访问频率，请稍后再试。',
    blocked: '请求被 ChatGPT 的反自动化机制拦截。你仍可在浏览器中打开分享页后手动复制内容。',
    timeout: '访问 ChatGPT 超时，请稍后重试。',
    network_error: '网络请求失败，请检查服务器网络后重试。',
    parse_failed: '页面已打开，但没有识别出对话数据。ChatGPT 页面结构可能刚刚发生变化。'
  };

  return { code, message: map[code] || raw };
}

app.post('/api/extract', rateLimit, async (req, res) => {
  try {
    const url = normalizeShareUrl(req.body?.url);
    const chat = await readSharedConversation(url);
    if (!chat.text) {
      return res.status(422).json({ ok: false, code: 'empty_transcript', error: '未提取到用户消息或 ChatGPT 正式回复。' });
    }
    res.json({ ok: true, data: { sourceUrl: url, ...chat } });
  } catch (err) {
    const info = friendlyError(err);
    const status = ['invalid_url', 'unsupported_host', 'not_a_share_link'].includes(info.code) ? 400
      : info.code === 'not_found' ? 404
      : info.code === 'rate_limited' ? 429
      : 502;
    res.status(status).json({ ok: false, code: info.code, error: info.message });
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
