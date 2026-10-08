import express from 'express';
import { readSharedConversation } from '../../shared/transcript.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeShareUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail('请输入 ChatGPT 分享链接。', 'invalid_url');
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('链接格式无效。', 'invalid_url');
  }

  const host = url.hostname.toLowerCase();
  if (!['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(host)) {
    throw fail('只支持 ChatGPT 的公开分享链接。', 'unsupported_host');
  }
  if (!url.pathname.startsWith('/share/')) {
    throw fail('这不是 ChatGPT 公开分享链接。', 'not_a_share_link');
  }
  url.hash = '';
  return url.toString();
}


function errorInfo(error) {
  let code = error?.code || 'extract_failed';
  if (error?.status === 404) code = 'not_found';
  if (error?.status === 429) code = 'rate_limited'; else if (error instanceof ChatGptShareAccessError) {
    code = 'not_public';
  } else if (error instanceof ChatGptShareParseError) {
    code = 'parse_failed';
  }

  const messages = {
    invalid_url: '链接格式无效。',
    unsupported_host: '只支持 ChatGPT 的分享链接。',
    not_a_share_link: '该地址不是 ChatGPT 公开分享链接。',
    not_found: '没有找到该分享页面，链接可能已失效或被删除。',
    not_public: '该对话当前无法公开访问，可能需要登录或属于受限工作区。',
    rate_limited: 'ChatGPT 暂时限制了访问频率，请稍后再试。',
    network_error: '网络请求失败，请稍后重试。',
    parse_failed: '页面可访问，但没有识别出对话数据。'
  };
  return { code, message: messages[code] || String(error?.message || '提取失败。') };
}


app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/extract', async (req, res) => {
  try {
    const sourceUrl = normalizeShareUrl(req.body?.url);
    const chat = await readSharedConversation(sourceUrl);
    if (!chat.text) return res.status(422).json({
      ok: false, code: 'empty_transcript', error: '未提取到用户消息或 ChatGPT 正式回复。'
    });
    res.json({ ok: true, data: { sourceUrl, ...chat } });
  } catch (error) {
    const info = errorInfo(error);
    const status = ['invalid_url', 'unsupported_host', 'not_a_share_link'].includes(info.code) ? 400
      : info.code === 'not_found' ? 404
      : info.code === 'rate_limited' ? 429
      : 502;
    res.status(status).json({ ok: false, code: info.code, error: info.message });
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
