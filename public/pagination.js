// Pagination is measured in pixels at the original 1080px canvas width.
// No downscaling: a single oversized answer is cut between text lines.
export const MAX_PAGE_HEIGHT = 6200;
export const IMAGE_WIDTH = 1080;
export const HEADER_HEIGHT = 142;
export const FOOTER_HEIGHT = 96;
export const MESSAGE_GAP = 54;

function pieceLayout(layout, entries) {
  const lines = entries.filter(item => item.kind === 'line').map(item => item.value);
  const media = entries.filter(item => item.kind === 'media').map(item => item.value);
  const pad = layout.isUser ? 22 : 4;
  return {
    ...layout, lines, media,
    height: Math.max(48, lines.length * layout.lineHeight +
      media.reduce((total, m) => total + m.drawHeight + 14, 0) + pad * 2)
  };
}

export function splitOversizedLayout(layout, budget) {
  if (layout.height <= budget) return [layout];
  const pad = layout.isUser ? 22 : 4;
  const entries = [
    ...layout.media.map(value => ({ kind: 'media', value, height: value.drawHeight + 14 })),
    ...layout.lines.map(value => ({ kind: 'line', value, height: layout.lineHeight }))
  ];
  if (!entries.length) return [layout];
  const chunks = [];
  let slice = [], height = pad * 2;
  for (const item of entries) {
    if (slice.length && height + item.height > budget) {
      chunks.push(pieceLayout(layout, slice));
      slice = [];
      height = pad * 2;
    }
    if (height + item.height > budget) {
      throw new Error('单个媒体元素超过允许的长图高度。');
    }
    slice.push(item);
    height += item.height;
  }
  if (slice.length) chunks.push(pieceLayout(layout, slice));
  return chunks;
}

// Returns pages of fragments: { messageIndex, layout, continuation }.
// All text lines and media occur in exactly one page, in their original order.
export function paginateLayouts(layouts, options = {}) {
  const pageHeight = options.pageHeight ?? MAX_PAGE_HEIGHT;
  const headerHeight = options.headerHeight ?? HEADER_HEIGHT;
  const footerHeight = options.footerHeight ?? FOOTER_HEIGHT;
  const gap = options.gap ?? MESSAGE_GAP;
  const usable = pageHeight - headerHeight - footerHeight;
  if (usable < 96) throw new Error('长图分页高度设置过小。');

  const pages = [[]];
  let occupied = 0;
  function newPage() {
    if (pages.at(-1).length) pages.push([]);
    occupied = 0;
  }
  function insert(fragment) {
    const page = pages.at(-1);
    const extra = occupied ? gap : 0;
    if (occupied + extra + fragment.layout.height > usable) newPage();
    const target = pages.at(-1);
    occupied += (target.length ? gap : 0) + fragment.layout.height;
    target.push(fragment);
  }

  layouts.forEach((layout, messageIndex) => {
    if (layout.height <= usable) {
      insert({ messageIndex, layout, continuation: false });
      return;
    }
    // Keep the start of a long answer together with the rest of its fragments.
    if (occupied > 0) newPage();
    splitOversizedLayout(layout, usable).forEach((part, i) => {
      if (i > 0) newPage();
      insert({ messageIndex, layout: part, continuation: i > 0 });
    });
  });
  return pages.filter(page => page.length);
}

export function imagePageHeight(page, options = {}) {
  return (options.headerHeight ?? HEADER_HEIGHT) +
    page.reduce((n, part) => n + part.layout.height, 0) +
    Math.max(0, page.length - 1) * (options.gap ?? MESSAGE_GAP) +
    (options.footerHeight ?? FOOTER_HEIGHT);
}
