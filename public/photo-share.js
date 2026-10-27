// Keep numbered conversation pages in an explicit, validated sequence before
// handing them to the OS. Photo-library display order is controlled by iOS.
export function pagePngFilename(base, page, total) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(total) || total < page) {
    throw new Error('长图页码无效。');
  }
  const digits = Math.max(3, String(total).length);
  return `${base}-ChatGPT-${String(page).padStart(digits, '0')}.png`;
}

export function makePhotoShareFiles(images, FileCtor = File, now = Date.now()) {
  if (!Array.isArray(images) || !images.length) throw new Error('没有可保存的长图。');
  const ordered = [...images].sort((a, b) => a.page - b.page);
  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i];
    if (item.page !== i + 1 || !item.blob || !item.filename) {
      throw new Error('长图顺序不完整，请重新生成后重试。');
    }
  }
  const firstModified = now - (ordered.length - 1) * 1000;
  return ordered.map((item, i) => new FileCtor([item.blob], item.filename, {
    type: 'image/png',
    lastModified: firstModified + i * 1000
  }));
}
