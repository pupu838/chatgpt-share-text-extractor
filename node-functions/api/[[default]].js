import express from 'express';
import {
  ChatGptShareAccessError,
  ChatGptShareFetchError,
  ChatGptShareParseError,
  fetchChatGptShare
} from 'chatgpt-share-parser';

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

function toIso(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

async function fetchViaRelay(sourceUrl) {
  const response = await fetch('https://chat-share-reader.vercel.app/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'read_shared_chat',
        arguments: { url: sourceUrl, format: 'json' }
      }
    })
  });
  if (!response.ok) throw fail(`中转服务返回 ${response.status}`, 'network_error');

  const envelope = await response.json();
  const text = envelope?.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw fail('中转服务未返回对话数据。', 'parse_failed');
  const data = JSON.parse(text);
  if (!Array.isArray(data.messages)) throw fail('中转服务返回格式无效。', 'parse_failed');
  return data;
}

async function readConversation(sourceUrl) {
  try {
    const chat = await fetchChatGptShare(sourceUrl);
    return {
      title: chat.title,
      model: chat.aiModel || null,
      updatedAt: toIso(chat.updatedAt),
      warnings: [],
      messages: chat.replies.map((reply, index) => ({
        index,
        role: reply.type,
        text: reply.statement,
        contentType: 'text',
        createdAt: toIso(reply.createdAt),
        assets: Array.isArray(reply.assets) ? reply.assets : []
      }))
    };
  } catch (directError) {
    const relayed = await fetchViaRelay(sourceUrl);
    return {
      title: relayed.title,
      model: relayed.model || null,
      updatedAt: relayed.updatedAt || null,
      warnings: relayed.warnings || ['已通过境外中转读取公开分享页。'],
      messages: relayed.messages.map((message) => ({
        ...message,
        assets: Array.isArray(message.assets) ? message.assets : []
      }))
    };
  }
}

function errorInfo(error) {
  let code = error?.code || 'extract_failed';
  if (error instanceof ChatGptShareFetchError) {
    code = error.status === 404 ? 'not_found'
      : error.status === 429 ? 'rate_limited'
      : error.status === 401 || error.status === 403 ? 'not_public'
      : 'network_error';
  } else if (error instanceof ChatGptShareAccessError) {
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

function isDisplayMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') return false;
  const text = message.text.trim();
  const hasPublicMedia = Array.isArray(message.assets) && message.assets.some((asset) => /^https:\/\//i.test(asset?.url || ''));
  if ((!text && !hasPublicMedia) || text === 'Original custom instructions no longer available') return false;
  if (message.role !== 'assistant') return true;

  const normalized = text
    .replace(/^[_*]+|[_*]+$/g, '')
    .trim();
  if (/^The output of this plugin was redacted\.?$/i.test(normalized)) return false;
  if (/^(?:Tool parameters|工具参数)\s*:/i.test(normalized)) return false;
  return !/^(?:已搜索\s*\d+\s*个网站|思考了\s*\d+(?:\.\d+)?s|Searched\s+\d+\s+sites?|Thought for\s+\d+(?:\.\d+)?s)$/i.test(normalized);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/extract', async (req, res) => {
  try {
    const sourceUrl = normalizeShareUrl(req.body?.url);
    const chat = await readConversation(sourceUrl);
    const messages = chat.messages.filter(isDisplayMessage);
    const text = messages.map((message) => {
      const role = ({ user: '用户', assistant: 'ChatGPT', tool: '工具' })[message.role] || message.role;
      return `${role}:\n${message.text.trim()}`;
    }).join('\n\n--------------------\n\n');

    if (!text) return res.status(422).json({ ok: false, code: 'empty_transcript', error: '未提取到文字消息。' });

    res.json({
      ok: true,
      data: {
        sourceUrl,
        title: chat.title || 'ChatGPT 分享对话',
        model: chat.model || null,
        messageCount: messages.length,
        updatedAt: chat.updatedAt,
        warnings: chat.warnings,
        text,
        messages
      }
    });
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
    const upstream = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' } });
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !type.startsWith('image/')) return res.status(404).end();
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(404).end();
  }
});

export default app;
