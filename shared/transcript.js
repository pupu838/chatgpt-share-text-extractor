import { decodeLoader, extractLoaderPayload, parseChatGptShareHtml, parseLegacyShare } from 'chatgpt-share-parser';

// By default only users and the last final answer of each turn are exported.
// Opt-in flags affect only material actually available in the public share.
const REASONING_TYPES = new Set(['reasoning_recap']);
// Never export raw thinking, analysis-channel contents or private model context.
// Only explicit public reasoning recaps may be selected.
const TOOL_TYPES = new Set(['tool_response', 'execution_output', 'tool_call', 'function_call']);
const NEVER_EXPOSE = new Set([
  'model_editable_context', 'user_editable_context', 'system_message', 'debug', 'thoughts', 'reasoning', 'analysis'
]);
const PUBLIC_TYPES = new Set(['text', 'multimodal_text', 'code', 'markdown', 'image', 'text_message']);
const NON_ANSWER_PATTERN = /^(?:The output of this plugin was redacted\.?|(?:Tool parameters|工具参数)\s*:|已搜索\s*\d+\s*个网站|思考了\s*\d+(?:\.\d+)?\s*s|Searched\s+\d+\s+sites?|Thought for\s+\d+(?:\.\d+)?\s*s)$/i;

// Default remains final-only. Explicit choices can include additional
// user-visible material from a public share, but never hidden analysis.
export function normalizeOptions(options = {}) {
  return {
    includeReasoning: options?.includeReasoning === true,
    includeTools: options?.includeTools === true,
    includeProgress: options?.includeProgress === true
  };
}

function channelOf(m) {
  return m?.channel ?? m?.metadata?.channel ?? m?.author?.channel ?? null;
}
function categoryOf(m) {
  if (!m || !['user', 'assistant', 'tool'].includes(m.role) || typeof m.text !== 'string') return 'skip';
  const type = m.contentType ?? m.content_type;
  const text = m.text.trim();
  const hasMedia = Array.isArray(m.assets) && m.assets.some(a => /^https:\/\//i.test(a?.url || ''));
  if ((!text && !hasMedia) || text === 'Original custom instructions no longer available') return 'skip';
  const channel = channelOf(m);
  if (m.metadata?.is_visually_hidden_from_conversation === true || NEVER_EXPOSE.has(type) || channel === 'analysis') return 'skip';
  if (m.role === 'user') return 'user';
  if (REASONING_TYPES.has(type)) return 'reasoning';
  const recipient = m.recipient ?? m.metadata?.recipient;
  if (m.role === 'tool' || TOOL_TYPES.has(type) || (recipient && !['all', 'user'].includes(recipient)) ||
      (type === 'code' && m.endTurn !== true && channel !== 'final')) return 'tools';
  if (channel === 'commentary' || NON_ANSWER_PATTERN.test(text.replace(/^[_*]+|[_*]+$/g, '').trim())) return 'progress';
  if (channel && channel !== 'final') return 'progress';
  if (type && !PUBLIC_TYPES.has(type)) return 'skip';
  return 'answer';
}
function outputMessage(m, index, category) {
  return {
    index,
    role: m.role,
    text: m.text,
    contentType: m.contentType ?? m.content_type ?? 'text',
    createdAt: m.createdAt ?? null,
    assets: Array.isArray(m.assets) ? m.assets : [],
    section: category,
    displayRole: category === 'reasoning' ? '思考过程' :
      category === 'tools' ? '工具过程' : category === 'progress' ? '中间进度' :
      m.role === 'user' ? '用户' : 'ChatGPT'
  };
}

export function filterVisibleMessages(source, options = {}) {
  if (!Array.isArray(source)) return [];
  const opts = normalizeOptions(options);
  const visible = [];
  let assistantTurn = [];
  function flush() {
    if (!assistantTurn.length) return;
    const candidate = assistantTurn.filter(m => categoryOf(m) === 'answer');
    const finals = candidate.filter(m => channelOf(m) === 'final');
    const ended = candidate.filter(m => m.endTurn === true);
    const keep = new Set(finals.length ? finals : ended.length ? ended : candidate.slice(-1));
    for (const m of assistantTurn) {
      const category = categoryOf(m);
      if (category === 'answer' && keep.has(m)) visible.push(outputMessage(m, visible.length, 'answer'));
      else if (category === 'reasoning' && opts.includeReasoning) visible.push(outputMessage(m, visible.length, category));
      else if (category === 'tools' && opts.includeTools) visible.push(outputMessage(m, visible.length, category));
      else if ((category === 'progress' || category === 'answer') && opts.includeProgress && !keep.has(m)) {
        visible.push(outputMessage(m, visible.length, 'progress'));
      }
    }
    assistantTurn = [];
  }
  for (const m of source) {
    if (m?.role === 'user') {
      flush();
      if (categoryOf(m) === 'user') visible.push(outputMessage(m, visible.length, 'user'));
    } else if (m?.role === 'assistant' || m?.role === 'tool') {
      assistantTurn.push(m);
    }
  }
  flush();
  return visible;
}

export function formatTranscript(messages) {
  return messages.map(m =>
    (m.displayRole || (m.role === 'user' ? '用户' : m.role === 'tool' ? '工具过程' : 'ChatGPT')) + ':\n' + m.text.trim()
  ).join('\n\n--------------------\n\n');
}

const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function iso(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const SHARE_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
const MAX_SHARE_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const UPSTREAM_CODES = { 401: 'upstream_denied', 403: 'upstream_denied', 404: 'not_found', 410: 'not_found', 429: 'rate_limited' };
const TERMINAL_ERRORS = new Set(['not_public', 'upstream_denied', 'rate_limited', 'response_too_large', 'empty_transcript']);
const RESPONSE_ERRORS = {
  invalid_url: [400, '请输入有效的 ChatGPT 分享链接。'],
  unsupported_host: [400, '只支持 ChatGPT 的公开分享链接。'],
  not_a_share_link: [400, '该地址不是 ChatGPT 公开分享链接。'],
  not_found: [404, '分享链接已失效或不存在。'],
  not_public: [403, '这条对话未向公众分享。'],
  rate_limited: [429, 'ChatGPT 暂时限制了访问频率，请稍后再试。'],
  empty_transcript: [422, '未提取到可导出的用户消息或 ChatGPT 回复。'],
  timeout: [504, '读取 ChatGPT 分享对话超时，请稍后重试。'],
  network_error: [502, '服务器连接 ChatGPT 时发生网络错误，请稍后重试。'],
  upstream_denied: [502, 'ChatGPT 拒绝了服务器的读取请求，请稍后重试。'],
  upstream_http_error: [502, 'ChatGPT 分享服务暂时无法返回有效响应，请稍后重试。'],
  parse_failed: [502, '已连接 ChatGPT，但无法识别分享对话的数据格式。'],
  response_too_large: [502, '这条分享对话的数据量超过了提取上限。'],
  extract_failed: [502, '提取分享对话时发生错误。']
};

class ShareReadError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function normalizeShareUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ShareReadError('invalid_url');
  const value = input.trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new ShareReadError('invalid_url');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new ShareReadError('invalid_url');
  }
  if (!SHARE_HOSTS.has(url.hostname)) throw new ShareReadError('unsupported_host');
  const match = /^\/share\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
  if (!match) throw new ShareReadError('not_a_share_link');
  return `https://chatgpt.com/share/${match[1]}`;
}

function getRawConversation(html) {
  const loader = extractLoaderPayload(html);
  if (loader) {
    const decoded = decodeLoader(loader);
    const data = decoded?.loaderData?.['routes/share.$shareId.($action)']?.serverResponse?.data;
    if (isObject(data)) return data;
  }
  const script = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (script) {
    const parsed = JSON.parse(script[1]);
    const data = parsed?.props?.pageProps?.serverResponse?.data;
    if (isObject(data)) return data;
  }
  return null;
}

function mayProduceReply(message) {
  const c = message?.content;
  if (!isObject(c)) return false;
  const attachments = message?.metadata?.attachments;
  if (Array.isArray(attachments) && attachments.some(a => a?.download_url || a?.file_url)) return true;
  if (c.content_type === 'thoughts') return Array.isArray(c.thoughts) &&
    c.thoughts.some(t => t?.summary || t?.content);
  if (c.content_type === 'reasoning_recap') return Boolean(c.content?.trim?.());
  if (c.content_type === 'model_editable_context') return Boolean(c.model_set_context?.trim?.());
  if (c.content_type === 'tool_response') return Boolean(c.output?.trim?.());
  if (c.content_type === 'code') return Boolean(c.text?.trim?.());
  return Array.isArray(c.parts) && c.parts.some(p => {
    if (typeof p === 'string') return Boolean(p.trim());
    return isObject(p) && Boolean(p.text || p.asset_pointer);
  });
}

function rawChannel(message) {
  return message.channel ?? message.author?.metadata?.channel ?? message.metadata?.channel ?? null;
}

function mapRawReply(reply, message, index) {
  return {
    index,
    role: reply.type,
    text: reply.statement,
    contentType: message.content?.content_type ?? 'text',
    createdAt: iso(reply.createdAt),
    assets: Array.isArray(reply.assets) ? reply.assets : [],
    channel: rawChannel(message),
    recipient: message.recipient ?? null,
    endTurn: message.end_turn,
    metadata: { is_visually_hidden_from_conversation: message.metadata?.is_visually_hidden_from_conversation }
  };
}

export function mapDirectMessages(replies, data) {
  const mapping = isObject(data?.mapping) ? data.mapping : {};
  const sequence = Array.isArray(data?.linear_conversation) ? data.linear_conversation : [];
  const raw = sequence.map(entry => {
    if (!isObject(entry)) return null;
    const mapped = entry.id && mapping[entry.id];
    return (isObject(mapped) ? mapped : entry)?.message;
  }).filter(message => isObject(message) && message.author?.role !== 'system' && mayProduceReply(message));
  // The parser drops empty messages. Never guess the index if alignment
  // differs, since a mismatched type might disclose thinking content.
  if (raw.length !== replies.length) throw new Error('无法核对原始消息类型。');
  return replies.map((reply, index) => {
    const message = raw[index];
    const role = message.author?.role === 'user' || message.author?.role === 'tool'
      ? message.author.role : 'assistant';
    if (reply.type !== role || (reply.createdAt != null && message.create_time != null &&
      reply.createdAt !== message.create_time)) {
      throw new Error('原始消息顺序与解析结果不一致。');
    }
    return mapRawReply(reply, message, index);
  });
}

function parseSharedHtml(html) {
  const parsed = parseChatGptShareHtml(html);
  const raw = getRawConversation(html);
  if (!raw || !Array.isArray(raw.linear_conversation)) throw new ShareReadError('parse_failed');
  if (raw.is_public === false) throw new ShareReadError('not_public');
  return {
    title: parsed.title,
    model: parsed.aiModel,
    updatedAt: parsed.updatedAt,
    candidates: mapDirectMessages(parsed.replies, raw)
  };
}

function shareNodes(data) {
  const mapping = isObject(data.mapping) ? data.mapping : {};
  if (Array.isArray(data.linear_conversation)) {
    return data.linear_conversation.map(entry => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      const node = id && Object.hasOwn(mapping, id) ? mapping[id] : entry;
      if (!isObject(node)) throw new ShareReadError('parse_failed');
      return node;
    });
  }

  if (typeof data.current_node !== 'string') throw new ShareReadError('parse_failed');
  const nodes = [];
  const visited = new Set();
  let id = data.current_node;
  while (id != null) {
    if (!Object.hasOwn(mapping, id) || !isObject(mapping[id]) || visited.has(id)) {
      throw new ShareReadError('parse_failed');
    }
    visited.add(id);
    const node = mapping[id];
    nodes.push(node);
    id = node.parent;
  }
  return nodes.reverse();
}

function parseSharedJson(body) {
  const data = JSON.parse(body);
  if (!isObject(data)) throw new ShareReadError('parse_failed');
  if (data.is_public === false) throw new ShareReadError('not_public');
  if (data.is_public !== true) throw new ShareReadError('parse_failed');

  const candidates = [];
  for (const node of shareNodes(data)) {
    const message = node.message;
    if (!isObject(message?.content) || !['user', 'assistant', 'tool'].includes(message.author?.role)) continue;
    if (message.metadata?.is_visually_hidden_from_conversation === true ||
        NEVER_EXPOSE.has(message.content.content_type) || rawChannel(message) === 'analysis') continue;

    // Reuse the package's text and attachment formatting. Parsing one node at
    // a time keeps its original metadata paired even when the parser skips a node.
    const payload = { props: { pageProps: { serverResponse: { data: { linear_conversation: [{ message }] } } } } };
    const encoded = JSON.stringify(payload).replaceAll('<', '\\u003c');
    const [reply] = parseLegacyShare(`<script id="__NEXT_DATA__">${encoded}</script>`).replies;
    if (reply) candidates.push(mapRawReply(reply, message, candidates.length));
  }
  return {
    title: data.title,
    model: data.model?.slug || data.default_model_slug,
    updatedAt: data.update_time,
    candidates
  };
}

async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ShareReadError('parse_failed');
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_SHARE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ShareReadError('response_too_large');
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function readSource(url, source, options, fetchImpl) {
  const json = source === 'public_json';
  const accept = json ? 'application/json' : 'text/html';
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const start = Date.now();
  let status = null;
  let contentType = null;
  try {
    const response = await fetchImpl(url, { headers: { Accept: accept }, redirect: 'manual', signal });
    status = response.status;
    contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? null;
    if (!response.ok || contentType !== accept) {
      void response.body?.cancel().catch(() => {});
      throw new ShareReadError(response.ok ? 'parse_failed' : UPSTREAM_CODES[status] || 'upstream_http_error');
    }
    const body = await readBody(response);
    let parsed;
    try {
      parsed = json ? parseSharedJson(body) : parseSharedHtml(body);
    } catch (error) {
      throw error instanceof ShareReadError ? error : new ShareReadError('parse_failed');
    }
    const messages = filterVisibleMessages(parsed.candidates, options);
    const text = formatTranscript(messages);
    if (!text) throw new ShareReadError('empty_transcript');
    return {
      source,
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : 'ChatGPT 分享对话',
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : null,
      updatedAt: iso(parsed.updatedAt),
      warnings: [],
      messageCount: messages.length,
      messages,
      text
    };
  } catch (error) {
    const failure = error instanceof ShareReadError ? error
      : new ShareReadError(signal.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'network_error');
    failure.attempts = [{ source, status, contentType, elapsedMs: Date.now() - start, code: failure.code }];
    throw failure;
  }
}

export async function readSharedConversation(sourceUrl, options = {}, fetchImpl = fetch) {
  const shareUrl = normalizeShareUrl(sourceUrl);
  const jsonUrl = shareUrl.replace('/share/', '/backend-anon/share/');
  try {
    return { sourceUrl: shareUrl, ...await readSource(jsonUrl, 'public_json', options, fetchImpl) };
  } catch (jsonError) {
    if (TERMINAL_ERRORS.has(jsonError.code)) throw jsonError;
    try {
      return { sourceUrl: shareUrl, ...await readSource(shareUrl, 'html', options, fetchImpl) };
    } catch (htmlError) {
      const useHtmlError = TERMINAL_ERRORS.has(htmlError.code) || htmlError.code === 'not_found' ||
        (htmlError.code === 'parse_failed' && jsonError.code !== 'not_found');
      const chosenError = useHtmlError ? htmlError : jsonError;
      chosenError.attempts = [...jsonError.attempts, ...htmlError.attempts];
      throw chosenError;
    }
  }
}

export function extractionErrorResponse(error) {
  const code = Object.hasOwn(RESPONSE_ERRORS, error?.code) ? error.code : 'extract_failed';
  const [status, message] = RESPONSE_ERRORS[code];
  if (error?.attempts) console.warn('ChatGPT share extraction failed', JSON.stringify(error.attempts));
  return { status, body: { ok: false, code, error: message } };
}
