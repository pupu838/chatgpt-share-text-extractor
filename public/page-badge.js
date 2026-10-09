// Draw a clearly visible page indicator in the header of every exported PNG.
// The canvas is 1080px wide; this badge stays anchored to the right margin.
export function drawPageNumberBadge(ctx, pageIndex, totalPages, width, side) {
  if (!ctx || !Number.isInteger(pageIndex) || !Number.isInteger(totalPages) ||
      totalPages < 1 || pageIndex < 0 || pageIndex >= totalPages) {
    throw new Error('Invalid page number for PNG export');
  }
  const label = `${pageIndex + 1} / ${totalPages}`;
  const height = 48;
  const paddingX = 20;
  const top = 35;
  const radius = 14;
  ctx.save();
  ctx.font = '700 34px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
  const badgeWidth = Math.ceil(ctx.measureText(label).width + paddingX * 2);
  const x = width - side - badgeWidth;
  ctx.beginPath();
  ctx.roundRect(x, top, badgeWidth, height, radius);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.10)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#111827';
  ctx.fillText(label, width - side - paddingX, top + height / 2);
  ctx.restore();
}
