import {
  decodeLoader,
  extractLoaderPayload,
  fetchChatGptShareHtml
} from 'chatgpt-share-parser';
import { readSharedConversation } from '../shared/transcript.js';

const url = 'https://chatgpt.com/share/6ac7af0c-fadc-83e8-86be-321c41df362a';
const live = 'https://chatgpt-share-text-extractor-global-zknlm0mo.edgeone.dev/api/extract';
const summarize = messages => ({
  messages: messages.length,
  users: messages.filter(m => m.role === 'user').length,
  assistants: messages.filter(m => m.role === 'assistant').length,
  types: messages.reduce((out, m) => {
    const key = m.contentType ?? m.content_type ?? 'unknown';
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {}),
  pendingReasoning: messages.filter(m => /^(?:thoughts|reasoning|reasoning_recap|analysis|tool_response)$/i.test(m.contentType ?? m.content_type ?? '')).length
});
const capture = async (name, fn) => {
  try { const result = await fn(); console.log(name, JSON.stringify(result)); }
  catch (error) { console.log(name, 'ERROR', error?.name, error?.code ?? error?.status ?? '', String(error?.message).slice(0, 250)); }
};

await capture('SOURCE_RAW_METADATA', async () => {
  const html = await fetchChatGptShareHtml(url);
  const loader = extractLoaderPayload(html);
  if (!loader) return { htmlBytes: html.length, loader: false };
  const decoded = decodeLoader(loader);
  const data = decoded?.loaderData?.['routes/share.$shareId.($action)']?.serverResponse?.data;
  const mapping = data?.mapping || {};
  const messages = (data?.linear_conversation || []).map(entry => (mapping[entry.id] || entry).message).filter(Boolean);
  const rows = messages.filter(m => m.author?.role === 'assistant').map(m => ({
    type: m.content?.content_type || 'unknown',
    channel: m.author?.metadata?.channel || m.metadata?.channel || 'missing',
    endTurn: m.end_turn === true
  }));
  const key = m => [m.type, m.channel, m.endTurn].join('/');
  return {
    htmlBytes: html.length, linearMessages: messages.length,
    assistantShapes: rows.reduce((out, m) => { const k = key(m); out[k] = (out[k] || 0) + 1; return out; }, {})
  };
});
await capture('LOCAL_EXTRACTOR', async () => {
  const result = await readSharedConversation(url);
  return { ...summarize(result.messages), warningCount: result.warnings?.length ?? 0 };
});
await capture('DEPLOYED_API', async () => {
  const response = await fetch(live, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(45000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) return { status: response.status, code: data.code, error: data.error };
  return {
    status: response.status,
    ...summarize(data.data.messages || []),
    warningCount: data.data.warnings?.length ?? 0
  };
});
