import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVisibleMessages, formatTranscript, normalizeOptions } from '../shared/transcript.js';
import { paginateLayouts, imagePageHeight, splitOversizedLayout, MAX_PAGE_HEIGHT } from '../public/pagination.js';
import { createZip } from '../public/zip.js';

const testMessages = [
  { role: 'user', contentType: 'text', text: 'Q' },
  { role: 'assistant', contentType: 'thoughts', text: 'Public thinking summary' },
  { role: 'assistant', contentType: 'reasoning_recap', text: 'Public recap' },
  { role: 'assistant', contentType: 'text', text: 'Searching...', channel: 'commentary' },
  { role: 'assistant', contentType: 'code', text: 'Tool arguments', recipient: 'web.run' },
  { role: 'tool', contentType: 'tool_response', text: 'Tool output' },
  { role: 'assistant', contentType: 'model_editable_context', text: 'system memory' },
  { role: 'assistant', contentType: 'text', text: '**Final**', endTurn: true }
];

test('options default to false, even if supplied as strings', () => {
  assert.deepEqual(normalizeOptions({ includeReasoning: 'true', includeTools: 'true' }), {
    includeReasoning: false, includeTools: false, includeProgress: false
  });
  assert.deepEqual(filterVisibleMessages(testMessages).map(m => m.text), ['Q', '**Final**']);
});

test('reasoning, tools and progress are never exposed, even if requested explicitly', () => {
  const requestedModes = [
    { includeReasoning: true },
    { includeTools: true },
    { includeProgress: true },
    { includeReasoning: true, includeTools: true, includeProgress: true }
  ];
  for (const mode of requestedModes) {
    assert.deepEqual(normalizeOptions(mode), {
      includeReasoning: false, includeTools: false, includeProgress: false
    });
    const filtered = filterVisibleMessages(testMessages, mode);
    assert.deepEqual(filtered.map(m => m.text), ['Q', '**Final**']);
    const transcript = formatTranscript(filtered);
    assert(!/Public thinking summary|Public recap|Tool arguments|Tool output|Searching\.\.\.|system memory/.test(transcript));
    assert(transcript.includes('ChatGPT:\n**Final**'));
  }
});

function layout(lines, media=[], isUser=false) {
  const lineHeight=43;
  const pad=isUser?22:4;
  const height=Math.max(48,lines.length*lineHeight+media.reduce((a,m)=>a+m.drawHeight+14,0)+2*pad);
  return {lines,media,isUser,lineHeight,maxTextWidth:760,height};
}
function flattenLines(pages) {
  return pages.flat().flatMap(item=>item.layout.lines);
}
function flattenMedia(pages) {
  return pages.flat().flatMap(item=>item.layout.media);
}

test('very long single response is split into full resolution pages with no lost lines', () => {
  const lines=Array.from({length:1500},(_,i)=>'Line '+i);
  const pages=paginateLayouts([layout(lines)]);
  assert(pages.length>7,'expected multiple pages');
  assert.deepEqual(flattenLines(pages),lines);
  assert(pages.every(p=>imagePageHeight(p)<=MAX_PAGE_HEIGHT));
  assert(pages.slice(1).every(p=>p[0].continuation));
});

test('short messages fit together, large messages start on a fresh page', () => {
  const messages=[layout(['first']),layout(Array(140).fill('long response')),layout(['ending'])];
  const pages=paginateLayouts(messages);
  assert(pages.length>=2);
  assert.deepEqual(flattenLines(pages),messages.flatMap(m=>m.lines));
  assert(pages.every(page=>imagePageHeight(page)<=MAX_PAGE_HEIGHT));
});

test('split image content preserves every media item and original order', () => {
  const media=Array.from({length:24},(_,i)=>({name:'image '+i,drawHeight:520}));
  const message=layout(['after images'],media);
  const parts=splitOversizedLayout(message,MAX_PAGE_HEIGHT-142-96);
  assert(parts.length>1);
  const pages=paginateLayouts([message]);
  assert.deepEqual(flattenMedia(pages),media);
  assert.deepEqual(flattenLines(pages),['after images']);
  assert(pages.every(p=>imagePageHeight(p)<=MAX_PAGE_HEIGHT));
});

test('ZIP of multiple PNG blobs contains correct local and central directory signatures',async()=>{
  const one=new Blob([new Uint8Array([137,80,78,71,10])],{type:'image/png'});
  const two=new Blob([new Uint8Array([137,80,78,71,11])],{type:'image/png'});
  const archive=await createZip([{name:'第01张.png',blob:one},{name:'第02张.png',blob:two}]);
  const bytes=new Uint8Array(await archive.arrayBuffer());
  const view=new DataView(bytes.buffer);
  assert.equal(view.getUint32(0,true),0x04034b50);
  assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);
  assert.equal(view.getUint16(bytes.length-22+10,true),2);
  assert(Buffer.from(bytes).includes(Buffer.from('第01张.png')));
  assert(Buffer.from(bytes).includes(Buffer.from('第02张.png')));
});
