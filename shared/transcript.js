import { decodeLoader, extractLoaderPayload, fetchChatGptShareHtml, parseChatGptShareHtml } from 'chatgpt-share-parser';

// By default only users and the last final answer of each turn are exported.
// Opt-in flags affect only material actually available in the public share.
const REASONING_TYPES = new Set(['thoughts', 'reasoning_recap', 'reasoning', 'analysis']);
const TOOL_TYPES = new Set(['tool_response', 'execution_output', 'tool_call', 'function_call']);
const NEVER_EXPOSE = new Set(['model_editable_context', 'system_message', 'debug']);
const PUBLIC_TYPES = new Set(['text', 'multimodal_text', 'code', 'markdown', 'image', 'text_message']);
const NON_ANSWER_PATTERN = /^(?:The output of this plugin was redacted\.?|(?:Tool parameters|工具参数)\s*:|已搜索\s*\d+\s*个网站|思考了\s*\d+(?:\.\d+)?\s*s|Searched\s+\d+\s+sites?|Thought for\s+\d+(?:\.\d+)?\s*s)$/i;

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
  if (m.metadata?.is_visually_hidden_from_conversation === true || NEVER_EXPOSE.has(type)) return 'skip';
  if (m.role === 'user') return 'user';
  const channel = channelOf(m);
  if (REASONING_TYPES.has(type) || channel === 'analysis') return 'reasoning';
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
const iso = x => Number.isFinite(x) ? new Date(x * 1000).toISOString() : null;

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
    return {
      index,
      role: reply.type,
      text: reply.statement,
      contentType: message.content?.content_type ?? 'text',
      createdAt: iso(reply.createdAt),
      assets: Array.isArray(reply.assets) ? reply.assets : [],
      channel: message.author?.metadata?.channel ?? message.metadata?.channel ?? null,
      recipient: message.recipient ?? null,
      endTurn: message.end_turn,
      metadata: { is_visually_hidden_from_conversation: message.metadata?.is_visually_hidden_from_conversation }
    };
  });
}

async function readDirect(sourceUrl, options) {
  const html = await fetchChatGptShareHtml(sourceUrl);
  const parsed = parseChatGptShareHtml(html);
  const raw = getRawConversation(html);
  if (!raw) throw new Error('无法读取原始消息元数据。');
  const messages = filterVisibleMessages(mapDirectMessages(parsed.replies, raw), options);
  return {
    title: parsed.title || 'ChatGPT 分享对话',
    model: parsed.aiModel || null,
    updatedAt: iso(parsed.updatedAt),
    warnings: [],
    messageCount: messages.length,
    messages,
    text: formatTranscript(messages)
  };
}

function mapRelayMessage(message) {
  const assets = Array.isArray(message.assets) ? [...message.assets] : [];
  for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
    if (!/^https:\/\//i.test(attachment?.url || '')) continue;
    assets.push({
      assetType: attachment.kind || 'file',
      url: attachment.url,
      filename: attachment.name || 'attachment',
      downloadable: true,
      description: null
    });
  }
  return { ...message, assets };
}

export async function readViaRelay(sourceUrl, fetchImpl, options = {}) {
  const collected = [];
  let offset = 0;
  let firstPage = null;
  for (let pageNumber = 0; pageNumber < 60; pageNumber++) {
    const response = await fetchImpl('https://chat-share-reader.vercel.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: pageNumber + 1,
        method: 'tools/call',
        params: {
          name: 'read_shared_chat',
          arguments: {
            url: sourceUrl, format: 'json',
            include_reasoning: options.includeReasoning === true, include_tool_output: options.includeTools === true,
            offset, limit: 200
          }
        }
      }),
      signal: AbortSignal.timeout(24000)
    });
    if (!response.ok) {
      const error = new Error('对话读取服务返回 ' + response.status);
      error.code = response.status === 401 || response.status === 403 ? 'not_public' : 'network_error';
      throw error;
    }
    let payload;
    try {
      const envelope = await response.json();
      if (envelope.error || envelope.result?.isError) throw new Error('读取服务返回错误。');
      const item = envelope.result?.content?.find(item => item.type === 'text');
      payload = JSON.parse(item?.text || '');
      if (!Array.isArray(payload.messages)) throw new Error('消息列表缺失。');
    } catch {
      throw Object.assign(new Error('无法解析分享对话。'), { code: 'parse_failed' });
    }
    if (!firstPage) firstPage = payload;
    collected.push(...payload.messages.map(mapRelayMessage));
    if (collected.length > 12000) {
      throw Object.assign(new Error('对话过长，超过读取上限。'), { code: 'parse_failed' });
    }
    const next = payload.window?.nextOffset ??
      (offset + payload.messages.length < payload.messageCount ? offset + payload.messages.length : null);
    if (next === null || next === undefined) {
      const expected = Number(payload.window?.total ?? payload.messageCount);
      if (Number.isFinite(expected) && offset + payload.messages.length < expected) {
        throw Object.assign(new Error('对话未读取完整。'), { code: 'parse_failed' });
      }
      const messages = filterVisibleMessages(collected, options);
      const warnings = Array.isArray(firstPage.warnings) ? [...firstPage.warnings] : [];
      if (collected.some(m => m.text?.includes('…[message truncated at'))) {
        warnings.push('备用读取服务已截断过长的单条消息。');
      }
      return {
        title: firstPage.title || 'ChatGPT 分享对话',
        model: firstPage.model || null,
        updatedAt: firstPage.updatedAt || null,
        warnings,
        messageCount: messages.length,
        messages,
        text: formatTranscript(messages)
      };
    }
    if (!Number.isInteger(next) || next <= offset || !payload.messages.length) {
      throw Object.assign(new Error('分页数据不完整。'), { code: 'parse_failed' });
    }
    offset = next;
  }
  throw Object.assign(new Error('对话页数超过读取上限。'), { code: 'parse_failed' });
}

export async function readSharedConversation(sourceUrl, options = {}, fetchImpl = fetch) {
  try {
    return await readDirect(sourceUrl, options);
  } catch (directError) {
    try {
      return await readViaRelay(sourceUrl, fetchImpl, options);
    } catch {
      const status = directError.status;
      throw Object.assign(directError, {
        code: directError.code || (
          status === 404 ? 'not_found' :
          status === 401 || status === 403 ? 'not_public' :
          status === 429 ? 'rate_limited' :
          directError.name?.includes('Parse') ? 'parse_failed' : 'network_error'
        )
      });
    }
  }
}
