import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, filterVisibleMessages, formatTranscript, mapDirectMessages, readViaRelay } from '../shared/transcript.js';

test('omits thinking, reasoning, commentary and tool output, keeping final answer verbatim', () => {
  const fencedCode = String.fromCharCode(96).repeat(3) + 'js\nanswer()\n' + String.fromCharCode(96).repeat(3);
  const finalText = '**正式回复**\n\n' + fencedCode;
  const messages = [
    { role: 'user', text: '用户原文' },
    { role: 'assistant', text: 'thinking', contentType: 'thoughts' },
    { role: 'assistant', text: 'reasoning', contentType: 'reasoning_recap' },
    { role: 'tool', text: 'tool output', contentType: 'tool_response' },
    { role: 'assistant', text: 'Searching', channel: 'commentary' },
    { role: 'assistant', text: finalText, channel: 'final' }
  ];
  const result = filterVisibleMessages(messages);
  assert.deepEqual(result.map(message => message.text), ['用户原文', finalText]);
  assert.equal(result[1].role, 'assistant');
  assert(!formatTranscript(result).includes('reasoning'));
});

test('with no explicit channel, only the final assistant message of the turn is kept', () => {
  const result = filterVisibleMessages([
    { role: 'user', text: 'Q' },
    { role: 'assistant', text: 'intermediate' },
    { role: 'assistant', text: 'Final A' },
    { role: 'user', text: 'Q2' },
    { role: 'assistant', text: 'Final B' }
  ]);
  assert.deepEqual(result.map(m => m.text), ['Q', 'Final A', 'Q2', 'Final B']);
});

test('multiple assistant messages marked final are preserved', () => {
  const result = filterVisibleMessages([
    { role: 'user', text: 'Q' },
    { role: 'assistant', text: 'First final paragraph', channel: 'final' },
    { role: 'assistant', text: 'Second final paragraph', channel: 'final' }
  ]);
  assert.equal(result.length, 3);
});

test('maps original ChatGPT message channels, end_turn, types and assets without text rewriting', () => {
  const entries = [
    { message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Hi'] }, create_time: 1 } },
    { message: { author: { role: 'assistant', metadata: { channel: 'analysis' } },
      content: { content_type: 'thoughts', thoughts: [{ summary: 'private thought' }] }, create_time: 2 } },
    { message: { author: { role: 'assistant', metadata: { channel: 'final' } },
      content: { content_type: 'text', parts: ['Final answer'] }, create_time: 3, end_turn: true } }
  ];
  const replies = [
    { type: 'user', statement: 'Hi', createdAt: 1, assets: [] },
    { type: 'assistant', statement: '_private thought_', createdAt: 2, assets: [] },
    { type: 'assistant', statement: 'Final answer', createdAt: 3,
      assets: [{ assetType: 'image', url: 'https://cdn.openai.com/foo.png', filename: 'foo.png' }] }
  ];
  const result = filterVisibleMessages(mapDirectMessages(replies, { linear_conversation: entries }));
  assert.deepEqual(result.map(message => message.text), ['Hi', 'Final answer']);
  assert.equal(result[1].assets[0].filename, 'foo.png');
});

test('rejects mismatched raw-message alignment instead of exposing ambiguous content', () => {
  assert.throws(() => mapDirectMessages(
    [{ type: 'assistant', statement: 'reasoning', createdAt: 1 }],
    { linear_conversation: [{ message: { author: { role: 'user' },
      content: { content_type: 'text', parts: ['Q'] }, create_time: 1 } }] }
  ), /不一致/);
});

test('relay explicitly disables reasoning and tool output and reads every page', async () => {
  const requests = [];
  const mockFetch = async (_url, options) => {
    const args = JSON.parse(options.body).params.arguments;
    requests.push(args);
    const offset = args.offset;
    const messages = offset === 0
      ? [{ role: 'user', text: 'First Q', contentType: 'text' },
         { role: 'assistant', text: 'First A', contentType: 'text' }]
      : [{ role: 'user', text: 'Second Q', contentType: 'text' },
         { role: 'assistant', text: 'Second A', contentType: 'text' }];
    const payload = {
      title: 'Multipage chat',
      messageCount: 4,
      messages,
      window: { offset, returned: 2, total: 4, nextOffset: offset === 0 ? 2 : null }
    };
    return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) };
  };
  const result = await readViaRelay('https://chatgpt.com/share/synthetic', mockFetch);
  assert.deepEqual(result.messages.map(message => message.text), ['First Q', 'First A', 'Second Q', 'Second A']);
  assert.deepEqual(requests.map(r => r.offset), [0, 2]);
  assert(requests.every(r => r.include_reasoning === false && r.include_tool_output === false));
  assert.equal(result.messageCount, 4);
});

test('relay fails closed on invalid pages', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ result: { content: [{ type: 'text', text: '{"title":"Broken","messages":[],"messageCount":10,"window":{"nextOffset":0}}' }] } })
  });
  await assert.rejects(() => readViaRelay('https://chatgpt.com/share/synthetic', mockFetch), /分页数据不完整/);
});

test('rejects all attempted opt-in flags from callers and public APIs', async () => {
  assert.deepEqual(normalizeOptions({
    includeReasoning: true, includeTools: true, includeProgress: true
  }), { includeReasoning: false, includeTools: false, includeProgress: false });
  const messages = [
    { role: 'user', text: 'Question' },
    { role: 'assistant', text: 'Reasoning', contentType: 'reasoning_recap' },
    { role: 'assistant', text: 'Tool output', contentType: 'tool_response' },
    { role: 'assistant', text: 'Commentary', channel: 'commentary' },
    { role: 'assistant', text: 'Answer', channel: 'final' }
  ];
  assert.deepEqual(filterVisibleMessages(messages, {
    includeReasoning: true, includeTools: true, includeProgress: true
  }).map(m => m.text), ['Question', 'Answer']);
});

test('even explicit relay options cannot re-enable internal content', async () => {
  const requests = [];
  const mockFetch = async (_url, init) => {
    const args = JSON.parse(init.body).params.arguments;
    requests.push(args);
    return {
      ok: true,
      json: async () => ({
        result: { content: [{
          type: 'text',
          text: JSON.stringify({
            title: 'Test', messageCount: 2,
            messages: [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A', channel: 'final' }]
          })
        }] }
      })
    };
  };
  await readViaRelay('https://chatgpt.com/share/test', mockFetch, {
    includeReasoning: true, includeTools: true, includeProgress: true
  });
  assert.equal(requests[0].include_reasoning, false);
  assert.equal(requests[0].include_tool_output, false);
});
