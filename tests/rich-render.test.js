import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRichLines, layoutRichLines, heightOfRichLines } from '../public/rich-render.js';
import { paginateLayouts, imagePageHeight, MAX_PAGE_HEIGHT } from '../public/pagination.js';

const content = [
  '# 今日学习计划',
  '<row align="center" gap={2} wrap="wrap">',
  '<badge color="secondary">六级冲刺第5天</badge>',
  '<text color="secondary" size="xs">距离考试还有46天</text>',
  '</row>',
  '今天的核心任务：**恢复六级精听**，不要遗漏。',
  '<box gap={2}>',
  '  <row align="center">',
  '    <box background="surface-secondary"><icon name="brain" size="lg"/></box>',
  '    <box flex="1">**第一步：正式SRS（15分钟）**</box>',
  '  </row>',
  '  - 听力训练',
  '  - **词汇**理解',
  '</box>',
  '<divider color="subtle"/>',
  '| 任务 | 时长 |',
  '| --- | --- |',
  '| 精听 | 30分钟 |',
  '| 单词 | 20分钟 |'
].join('\n');

test('DIL style tags become semantic lines without leaking markup', () => {
  const lines=parseRichLines(content);
  const text=lines.flatMap(line=>line.runs.map(run=>run.text)).join(' ');
  assert(lines.some(line=>line.kind==='h1'));
  assert(lines.some(line=>line.kind==='rule'));
  assert(lines.some(line=>line.kind==='table'));
  assert(lines.some(line=>line.runs.some(run=>run.style.badge)));
  assert(lines.some(line=>line.runs.some(run=>run.style.badge)&&line.runs.some(run=>run.text.includes('距离考试还有46天'))));
  assert(lines.some(line=>line.runs.some(run=>run.style.bold)));
  assert(text.includes('🧠'));
  assert(text.includes('第一步：正式SRS'));
  assert(!/<\/?(row|box|text|badge|icon|divider)\b/.test(text));
  assert(!text.includes('gap={2}'));
  assert(!text.includes('**恢复六级精听**'));
  assert(!text.includes('| --- | --- |'));
});

test('indented component source is trimmed without eating Chinese text', () => {
  const lines=parseRichLines('<box>\n    **加粗标题**\n    普通内容\n</box>');
  assert.equal(lines.filter(x=>x.kind==='p')[0].runs[0].text,'加粗标题');
  assert(lines.some(x=>x.runs.some(r=>r.text==='普通内容')));
});

test('image wraps rich content and preserves reading order across pages', () => {
  const ctx={ font:'', measureText:(s)=>({width:[...s].length*16}) };
  const docs=Array.from({length:60},()=>parseRichLines(content)).flat();
  const wrapped=layoutRichLines(ctx,docs,600);
  const height=heightOfRichLines(wrapped);
  assert(height>MAX_PAGE_HEIGHT);
  const layout={isUser:false,lines:wrapped,lineHeight:43,media:[],maxTextWidth:600,height:Math.max(48,height+8)};
  const pages=paginateLayouts([layout]);
  assert(pages.length>1);
  assert(pages.every(p=>imagePageHeight(p)<=MAX_PAGE_HEIGHT));
  const actual=pages.flat().flatMap(part=>part.layout.lines);
  assert.deepEqual(actual,wrapped);
});

test('untrusted scripts cannot create executable preview content', () => {
  const lines=parseRichLines('<script>alert("x")</script><img src="x" onerror="alert(1)">安全**文本**');
  const text=lines.flatMap(x=>x.runs.map(r=>r.text)).join('');
  assert(!text.includes('<script'));
  assert(!text.includes('onerror'));
  assert(text.includes('安全文本'));
});

test('code fences retain literal component snippets while normal content is formatted', () => {
  const marker=String.fromCharCode(96).repeat(3);
  const input=marker+'html\n<row gap={2}><badge>原始代码</badge></row>\n'+marker+'\n'+'<badge>正常标签</badge>';
  const lines=parseRichLines(input);
  const code=lines.filter(x=>x.kind==='code').map(x=>x.runs.map(r=>r.text).join('')).join('\n');
  assert(code.includes('<row gap={2}>'));
  assert(code.includes('<badge>原始代码</badge>'));
  const badges=lines.filter(x=>x.runs.some(r=>r.style.badge));
  assert.equal(badges.length,1);
  assert(badges[0].runs.some(r=>r.text.includes('正常标签')));
});
