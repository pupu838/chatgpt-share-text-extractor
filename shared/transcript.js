const PUBLIC_CONTENT_TYPES = new Set([
  'text', 'multimodal_text', 'code', 'markdown', 'image', 'text_message'
]);
const BLOCKED_CONTENT_TYPES = new Set([
  'thoughts', 'reasoning', 'reasoning_recap', 'analysis',
  'tool_response', 'execution_output', 'tool_call', 'function_call',
  'model_editable_context', 'system_message', 'debug'
]);
const NON_ANSWER_PATTERN = /^(?:The output of this plugin was redacted\.?|(?:Tool parameters|工具参数)\s*:|已搜索\s*\d+\s*个网站|思考了\s*\d+(?:\.\d+)?\s*s|Searched\s+\d+\s+sites?|Thought for\s+\d+(?:\.\d+)?\s*s)$/i;

function channelOf(message) {
  return message.channel ?? message.metadata?.channel ?? message.metadata?.message_type ?? null;
}

function isPublicMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return false;
  if (typeof message.text !== 'string') return false;

  const contentType = message.contentType ?? message.content_type;
  if (BLOCKED_CONTENT_TYPES.has(contentType)) return false;
  if (message.role === 'assistant' && contentType && !PUBLIC_CONTENT_TYPES.has(contentType)) return false;

  const text = message.text.trim();
  const media = Array.isArray(message.assets) && message.assets.some(asset => /^https:\/\//i.test(asset?.url || ''));
  if ((!text && !media) || text === 'Original custom instructions no longer available') return false;

  if (message.role === 'user') return true;
  if (NON_ANSWER_PATTERN.test(text.replace(/^[_*]+|[_*]+$/g, '').trim())) return false;

  // Explicitly non-final assistant channels/recipients must never appear.
  const channel = channelOf(message);
  if (channel && channel !== 'final') return false;
  const recipient = message.recipient ?? message.metadata?.recipient;
  if (recipient && recipient !== 'all' && recipient !== 'user') return false;
  if (message.is_final === false || message.isFinal === false) return false;
  return true;
}

export function filterVisibleMessages(source) {
  if (!Array.isArray(source)) return [];
  const visible = [];
  let assistantMessages = [];

  function flushAssistantTurn() {
    if (!assistantMessages.length) return;
    // Keep all explicitly final messages. For older parsers with no channel
    // metadata, only the last assistant message of each user turn is shown.
    // This avoids exposing earlier commentary/progress as independent replies.
    const finals = assistantMessages.filter(message => channelOf(message) === 'final');
    visible.push(...(finals.length ? finals : assistantMessages.slice(-1)));
    assistantMessages = [];
  }

  for (const message of source) {
    if (message?.role === 'user') {
      flushAssistantTurn();
      if (isPublicMessage(message)) visible.push(message);
    } else if (message?.role === 'assistant' && isPublicMessage(message)) {
      assistantMessages.push(message);
    }
  }
  flushAssistantTurn();

  return visible.map((message, index) => ({
    index,
    role: message.role,
    text: message.text,
    contentType: message.contentType ?? message.content_type ?? 'text',
    createdAt: message.createdAt ?? null,
    assets: Array.isArray(message.assets) ? message.assets : []
  }));
}

export function formatTranscript(messages) {
  return messages.map(message =>
    `${message.role === 'user' ? '用户' : 'ChatGPT'}:\n${message.text.trim()}`
  ).join('\n\n--------------------\n\n');
}

export async function readSharedConversation(sourceUrl, fetchImpl = fetch) {
  // The relay explicitly supports omitting reasoning and tool output before
  // text is flattened. A parser that already flattened them cannot reliably
  // distinguish private/intermediate content by string matching afterwards.
  const response = await fetchImpl('https://chat-share-reader.vercel.app/mcp', {
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
        arguments: {
          url: sourceUrl,
          format: 'json',
          include_reasoning: false,
          include_tool_output: false
        }
      }
    }),
    signal: AbortSignal.timeout(24000)
  });
  if (!response.ok) {
    throw Object.assign(new Error(`对话读取服务返回 ${response.status}`), { code: 'network_error' });
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

  const messages = filterVisibleMessages(payload.messages);
  return {
    title: payload.title || 'ChatGPT 分享对话',
    model: payload.model || null,
    updatedAt: payload.updatedAt || null,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    messageCount: messages.length,
    messages,
    text: formatTranscript(messages)
  };
}
