import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatGptShareAccessError,
  ChatGptShareFetchError,
  ChatGptShareParseError,
  fetchChatGptShare
} from 'chatgpt-share-parser';

function toIso(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

async function extractTranscript(url) {
  try {
    const chat = await fetchChatGptShare(url);
    const messages = chat.replies.map((reply, index) => ({
      index,
      role: reply.type,
      text: reply.statement,
      contentType: 'text',
      createdAt: toIso(reply.createdAt)
    }));

    return {
      title: chat.title,
      model: chat.aiModel || null,
      messageCount: messages.length,
      updatedAt: toIso(chat.updatedAt),
      warnings: [],
      messages
    };
  } catch (error) {
    if (error instanceof ChatGptShareFetchError) {
      const code = error.status === 404 ? 'not_found'
        : error.status === 429 ? 'rate_limited'
        : error.status === 401 || error.status === 403 ? 'not_public'
        : 'network_error';
      throw Object.assign(error, { code });
    }
    if (error instanceof ChatGptShareAccessError) {
      throw Object.assign(error, { code: 'not_public' });
    }
    if (error instanceof ChatGptShareParseError) {
      throw Object.assign(error, { code: 'parse_failed' });
    }
    throw error;
  }
}

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

function plainText(chat) {
  return (chat.messages || [])
    .filter(isDisplayMessage)
    .map((m) => {
      const role = ({ user: '用户', assistant: 'ChatGPT', system: '系统', tool: '工具' })[m.role] || m.role || '未知';
      return `${role}:\n${m.text.trim()}`;
    })
    .join('\n\n--------------------\n\n');
}

function isDisplayMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') return false;
  const text = message.text.trim();
  if (!text || text === 'Original custom instructions no longer available') return false;
  if (message.role !== 'assistant') return true;

  const normalized = text
    .replace(/^[_*]+|[_*]+$/g, '')
    .trim();
  if (/^The output of this plugin was redacted\.?$/i.test(normalized)) return false;
  if (/^(?:Tool parameters|工具参数)\s*:/i.test(normalized)) return false;
  return !/^(?:已搜索\s*\d+\s*个网站|思考了\s*\d+(?:\.\d+)?s|Searched\s+\d+\s+sites?|Thought for\s+\d+(?:\.\d+)?s)$/i.test(normalized);
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
    const chat = await extractTranscript(url);
    const displayMessages = (chat.messages || []).filter(isDisplayMessage);
    const text = plainText(chat);

    if (!text) {
      return res.status(422).json({
        ok: false,
        code: 'empty_transcript',
        error: '页面可访问，但未提取到可显示的文字消息。'
      });
    }

    res.json({
      ok: true,
      data: {
        sourceUrl: url,
        title: chat.title || 'ChatGPT 分享对话',
        model: chat.model || null,
        messageCount: displayMessages.length,
        updatedAt: chat.updatedAt || null,
        warnings: Array.isArray(chat.warnings) ? chat.warnings : [],
        text,
        messages: displayMessages
          .map(({ index, role, text, contentType, createdAt }) => ({ index, role, text, contentType, createdAt }))
      }
    });
  } catch (err) {
    const info = friendlyError(err);
    const status = ['invalid_url', 'unsupported_host', 'not_a_share_link'].includes(info.code) ? 400
      : info.code === 'not_found' ? 404
      : info.code === 'rate_limited' ? 429
      : 502;
    res.status(status).json({ ok: false, code: info.code, error: info.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ChatGPT share text extractor: http://localhost:${PORT}`);
});
