import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, filterVisibleMessages, formatTranscript, mapDirectMessages, readSharedConversation } from '../shared/transcript.js';

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

test('user can opt into public recap, tools and progress independently', () => {
  assert.deepEqual(normalizeOptions({
    includeReasoning: true, includeTools: true, includeProgress: true
  }), { includeReasoning: true, includeTools: true, includeProgress: true });
  const messages = [
    { role: 'user', text: 'Question' },
    { role: 'assistant', text: 'Hidden thinking', contentType: 'thoughts' },
    { role: 'assistant', text: 'Hidden analysis', channel: 'analysis', contentType: 'text' },
    { role: 'assistant', text: 'Public recap', contentType: 'reasoning_recap' },
    { role: 'assistant', text: 'Tool output', contentType: 'tool_response' },
    { role: 'assistant', text: 'Hidden tool output', contentType: 'tool_response',
      metadata: { is_visually_hidden_from_conversation: true } },
    { role: 'assistant', text: 'Commentary', channel: 'commentary' },
    { role: 'assistant', text: 'Answer', channel: 'final' }
  ];
  assert.deepEqual(filterVisibleMessages(messages, {
    includeReasoning: true, includeTools: true, includeProgress: true
  }).map(m => m.text), ['Question', 'Public recap', 'Tool output', 'Commentary', 'Answer']);
  assert.deepEqual(filterVisibleMessages(messages, { includeProgress: true })
    .map(m => m.text), ['Question', 'Commentary', 'Answer']);
});

const shareUrl = 'https://chatgpt.com/share/test-share';
const jsonUrl = 'https://chatgpt.com/backend-anon/share/test-share';

function shareMessage(role, text, fields = {}) {
  return { author: { role }, content: { content_type: 'text', parts: [text] }, ...fields };
}

function htmlWithShare(messages) {
  const data = { title: 'Old share', linear_conversation: messages.map(message => ({ message })) };
  const payload = { props: { pageProps: { serverResponse: { data } } } };
  return new Response('<script id="__NEXT_DATA__">' + JSON.stringify(payload) + '</script>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

test('a public JSON share is read in order with metadata, exports and safe filtering', async () => {
  const userText = 'Literal </script> and 中文';
  const data = {
    is_public: true,
    title: 'Public share',
    default_model_slug: 'gpt-example',
    update_time: 10,
    linear_conversation: [{ id: 'q' }, { id: 'internal' }, { id: 'empty' }, { id: 'aside' }, { id: 'file' }, { id: 'final' }],
    mapping: {
      q: { message: shareMessage('user', userText) },
      internal: { message: shareMessage('assistant', 'Hidden payload', { channel: 'analysis' }) },
      empty: { message: shareMessage('assistant', '', { channel: 'commentary' }) },
      aside: { message: shareMessage('assistant', 'Public progress', { channel: 'commentary' }) },
      file: { message: shareMessage('tool', 'Public tool output') },
      final: { message: shareMessage('assistant', 'Final answer', { channel: 'final', end_turn: true,
        metadata: { attachments: [{ name: 'example.png', file_type: 'image', file_url: 'https://cdn.openai.com/example.png' }] }
      }) },
      otherBranch: { message: shareMessage('assistant', 'Other branch', { channel: 'final' }) }
    }
  };
  const mockFetch = async (url, init) => {
    assert.equal(url, jsonUrl);
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.redirect, 'manual');
    return Response.json(data);
  };
  const clean = await readSharedConversation(shareUrl + '?ogimg=plain', {}, mockFetch);
  assert.equal(clean.source, 'public_json');
  assert.equal(clean.sourceUrl, shareUrl);
  assert.equal(clean.title, 'Public share');
  assert.equal(clean.model, 'gpt-example');
  assert.equal(clean.updatedAt, '1970-01-01T00:00:10.000Z');
  assert.deepEqual(clean.messages.map(m => m.section), ['user', 'answer']);
  assert.equal(clean.messages[0].text, userText);
  assert.equal(clean.messages[1].assets[0].filename, 'example.png');
  const opt = await readSharedConversation(shareUrl, {
    includeReasoning: true, includeTools: true, includeProgress: true
  }, mockFetch);
  assert.deepEqual(opt.messages.map(m => m.section), ['user', 'progress', 'tools', 'answer']);
  assert.equal(opt.messages.at(-1).text, clean.messages.at(-1).text);
  assert.ok(!opt.text.includes('Hidden payload') && !opt.text.includes('Other branch'));
});

test('follows the current branch when the JSON share has no linear conversation', async () => {
  const result = await readSharedConversation(shareUrl, {}, async () => Response.json({
    is_public: true,
    current_node: 'final',
    mapping: {
      root: {},
      q: { parent: 'root', message: shareMessage('user', 'Question') },
      oldAnswer: { parent: 'q', message: shareMessage('assistant', 'Old answer', { channel: 'final' }) },
      final: { parent: 'q', message: shareMessage('assistant', 'Current answer', { channel: 'final' }) }
    }
  }));
  assert.deepEqual(result.messages.map(m => m.text), ['Question', 'Current answer']);
});

test('legacy share page remains readable when the public JSON endpoint returns 404', async () => {
  const urls = [];
  const legacyUrl = 'https://chat.openai.com/share/test-share/';
  const result = await readSharedConversation(legacyUrl, {}, async url => {
    urls.push(url);
    if (url === jsonUrl) return new Response(null, { status: 404 });
    return htmlWithShare([shareMessage('user', 'Question'), shareMessage('assistant', 'Legacy answer')]);
  });
  assert.deepEqual(urls, [jsonUrl, shareUrl]);
  assert.equal(result.source, 'html');
  assert.deepEqual(result.messages.map(m => m.text), ['Question', 'Legacy answer']);
});

test('reports a format error when both responses are public pages without conversation data', async () => {
  const mockFetch = async url => url === jsonUrl
    ? Response.json({ title: 'Only metadata' })
    : new Response('<title>Public preview</title>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(() => readSharedConversation(shareUrl, {}, mockFetch), error => {
    assert.equal(error.code, 'parse_failed');
    assert.deepEqual(error.attempts.map(({ source, status, code }) => [source, status, code]),
      [['public_json', 200, 'parse_failed'], ['html', 200, 'parse_failed']]);
    return true;
  });
});

test('restricted, rate-limited and explicitly nonpublic shares keep their own error codes', async () => {
  for (const [response, code] of [
    [new Response(null, { status: 403 }), 'upstream_denied'],
    [new Response(null, { status: 429 }), 'rate_limited'],
    [Response.json({ is_public: false }), 'not_public']
  ]) {
    let calls = 0;
    await assert.rejects(() => readSharedConversation(shareUrl, {}, async () => {
      calls++;
      return response;
    }), { code });
    assert.equal(calls, 1);
  }
});

test('prevents outgoing reads for unsupported links and classifies deadline errors', async () => {
  let called = false;
  await assert.rejects(() => readSharedConversation('https://example.org/share/test-share', {}, async () => {
    called = true;
  }), { code: 'unsupported_host' });
  assert.equal(called, false);
  await assert.rejects(() => readSharedConversation(shareUrl, {}, async () => {
    throw new DOMException('Deadline', 'TimeoutError');
  }), { code: 'timeout' });
});
