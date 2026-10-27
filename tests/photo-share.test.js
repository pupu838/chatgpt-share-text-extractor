import test from 'node:test';
import assert from 'node:assert/strict';
import { makePhotoShareFiles, pagePngFilename } from '../public/photo-share.js';

class FakeFile {
  constructor(parts, name, options) {
    this.parts = parts;
    this.name = name;
    this.type = options.type;
    this.lastModified = options.lastModified;
  }
}

test('ordered filenames remain lexically ordered beyond 99 pages', () => {
  assert.equal(pagePngFilename('对话', 1, 120), '对话-ChatGPT-001.png');
  assert.equal(pagePngFilename('对话', 100, 120), '对话-ChatGPT-100.png');
  assert.equal(pagePngFilename('对话', 120, 120), '对话-ChatGPT-120.png');
  const filenames = Array.from({ length: 120 }, (_, i) => pagePngFilename('对话', i + 1, 120));
  assert.deepEqual([...filenames].sort(), filenames);
});

test('photo share sorts deliberately scrambled pages and assigns ascending modification times', () => {
  const entries = [3, 1, 2].map(page => ({
    page, filename: pagePngFilename('对话', page, 3),
    blob: new Blob(['p' + page], { type: 'image/png' })
  }));
  const files = makePhotoShareFiles(entries, FakeFile, 100000);
  assert.deepEqual(files.map(file => file.name), [
    '对话-ChatGPT-001.png', '对话-ChatGPT-002.png', '对话-ChatGPT-003.png'
  ]);
  assert.deepEqual(files.map(file => file.lastModified), [98000, 99000, 100000]);
  assert(files.every(file => file.type === 'image/png'));
});

test('refuse an incomplete or duplicated group rather than sharing out-of-order pages', () => {
  const entry = page => ({
    page, filename: pagePngFilename('对话', page, 4),
    blob: new Blob(['p' + page], { type: 'image/png' })
  });
  assert.throws(() => makePhotoShareFiles([entry(1), entry(3)], FakeFile), /顺序不完整/);
  assert.throws(() => makePhotoShareFiles([entry(1), entry(1)], FakeFile), /顺序不完整/);
  assert.throws(() => makePhotoShareFiles([], FakeFile), /没有可保存/);
});
