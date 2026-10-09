import test from 'node:test';
import assert from 'node:assert/strict';
import { drawPageNumberBadge } from '../public/page-badge.js';

function fakeCanvasContext() {
  const calls = [];
  const ctx = {
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    measureText(text) { calls.push(['measureText', text]); return { width: text.length * 21 }; },
    beginPath() { calls.push(['beginPath']); },
    roundRect(...args) { calls.push(['roundRect', ...args]); },
    fill() { calls.push(['fill']); },
    stroke() { calls.push(['stroke']); },
    fillText(...args) { calls.push(['fillText', ...args]); }
  };
  return { ctx, calls };
}

test('renders an outlined, bold page badge at upper right with 1 / 9 text', () => {
  const { ctx, calls } = fakeCanvasContext();
  drawPageNumberBadge(ctx, 0, 9, 1080, 112);
  const label = calls.find(c => c[0] === 'fillText');
  const pill = calls.find(c => c[0] === 'roundRect');
  assert.deepEqual(label, ['fillText', '1 / 9', 1080 - 112 - 20, 35 + 24]);
  assert.equal(pill[1] + pill[3], 1080 - 112);
  assert.equal(pill[2], 35);
  assert.equal(pill[4], 48);
  assert.equal(ctx.textAlign, 'right');
  assert.match(ctx.font, /700 34px/);
  assert(calls.some(c => c[0] === 'fill'));
  assert(calls.some(c => c[0] === 'stroke'));
  assert.equal(calls.at(-1)[0], 'restore');
});

test('page badge formats 1 / 1, 9 / 9, and 12 / 120 consistently', () => {
  for (const [index, count, expected] of [[0,1,'1 / 1'],[8,9,'9 / 9'],[11,120,'12 / 120']]) {
    const { ctx, calls } = fakeCanvasContext();
    drawPageNumberBadge(ctx, index, count, 1080, 112);
    assert.equal(calls.find(c => c[0] === 'fillText')[1], expected);
    assert.equal(calls.find(c => c[0] === 'roundRect')[1] +
      calls.find(c => c[0] === 'roundRect')[3], 968);
  }
});

test('invalid page indices are rejected', () => {
  assert.throws(() => drawPageNumberBadge(fakeCanvasContext().ctx, 9, 9, 1080, 112));
});
