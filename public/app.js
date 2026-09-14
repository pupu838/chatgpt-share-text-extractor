const form = document.querySelector('#extractForm');
const input = document.querySelector('#shareUrl');
const submitBtn = document.querySelector('#submitBtn');
const statusBox = document.querySelector('#status');
const result = document.querySelector('#result');
const title = document.querySelector('#title');
const meta = document.querySelector('#meta');
const transcript = document.querySelector('#transcript');
const warnings = document.querySelector('#warnings');
const copyBtn = document.querySelector('#copyBtn');
const downloadBtn = document.querySelector('#downloadBtn');
const downloadImageBtn = document.querySelector('#downloadImageBtn');
const imageResult = document.querySelector('#imageResult');
const imageMeta = document.querySelector('#imageMeta');
const longImage = document.querySelector('#longImage');

let latest = null;
let latestImageUrl = null;

function showStatus(message, kind = 'info') {
  statusBox.className = `status ${kind}`;
  statusBox.textContent = message;
}

function hideStatus() {
  statusBox.className = 'status hidden';
  statusBox.textContent = '';
}

function safeFilename(value) {
  return (value || 'chatgpt-conversation')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'chatgpt-conversation';
}

function cleanMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/`([^`]+)`/g, '$1');
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const char of paragraph) {
      const candidate = line + char;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = char;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function drawChatGptMark(ctx, x, y) {
  ctx.save();
  ctx.fillStyle = '#10a37f';
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    const next = angle + Math.PI / 3;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * 12, y + Math.sin(angle) * 12);
    ctx.lineTo(x + Math.cos(next) * 12, y + Math.sin(next) * 12);
    ctx.stroke();
  }
  ctx.restore();
}

function layoutMessage(ctx, message, contentWidth) {
  const isUser = message.role === 'user';
  const fontSize = 27;
  const lineHeight = 43;
  ctx.font = `${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif`;
  const maxTextWidth = isUser ? 650 : contentWidth - 78;
  const lines = wrapLines(ctx, cleanMarkdown(message.text || ''), maxTextWidth);
  const paddingY = isUser ? 22 : 4;
  return { isUser, lines, lineHeight, maxTextWidth, height: Math.max(48, lines.length * lineHeight + paddingY * 2) };
}

async function generateLongImage(data) {
  imageResult.classList.remove('hidden');
  imageMeta.textContent = '正在生成…';
  downloadImageBtn.disabled = true;

  await document.fonts?.ready;
  const width = 1080;
  const side = 112;
  const contentWidth = width - side * 2;
  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d');
  const layouts = (data.messages || []).map((message) => layoutMessage(measure, message, contentWidth));
  const headerHeight = 142;
  const gap = 54;
  const footerHeight = 96;
  const naturalHeight = headerHeight + layouts.reduce((sum, item) => sum + item.height + gap, 0) + footerHeight;
  const maxHeight = 30000;
  const scale = Math.min(1, maxHeight / naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, naturalHeight);

  ctx.fillStyle = '#0d0d0d';
  ctx.font = '700 30px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('ChatGPT', side, 66);
  ctx.fillStyle = '#6b6b6b';
  ctx.font = '22px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(data.title || 'ChatGPT conversation', side, 105);
  ctx.strokeStyle = '#ececec';
  ctx.beginPath();
  ctx.moveTo(side, 128);
  ctx.lineTo(width - side, 128);
  ctx.stroke();

  let y = headerHeight;
  layouts.forEach((layout, index) => {
    const message = data.messages[index];
    ctx.font = '27px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'top';
    if (layout.isUser) {
      const widest = Math.min(layout.maxTextWidth, Math.max(...layout.lines.map((line) => ctx.measureText(line).width), 40));
      const bubbleWidth = widest + 54;
      const x = width - side - bubbleWidth;
      ctx.fillStyle = '#f4f4f4';
      roundedRect(ctx, x, y, bubbleWidth, layout.height, 28);
      ctx.fillStyle = '#0d0d0d';
      layout.lines.forEach((line, lineIndex) => ctx.fillText(line, x + 27, y + 22 + lineIndex * layout.lineHeight));
    } else {
      drawChatGptMark(ctx, side + 22, y + 24);
      ctx.fillStyle = '#0d0d0d';
      layout.lines.forEach((line, lineIndex) => ctx.fillText(line, side + 72, y + 4 + lineIndex * layout.lineHeight));
    }
    y += layout.height + gap;
  });

  ctx.fillStyle = '#9b9b9b';
  ctx.font = '19px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Generated from a public ChatGPT share link', side, naturalHeight - 48);

  const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('长图生成失败')), 'image/png'));
  if (latestImageUrl) URL.revokeObjectURL(latestImageUrl);
  latestImageUrl = URL.createObjectURL(blob);
  longImage.src = latestImageUrl;
  imageMeta.textContent = `${canvas.width} × ${canvas.height}px · ${(blob.size / 1024 / 1024).toFixed(1)}MB`;
  downloadImageBtn.disabled = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.classList.add('hidden');
  imageResult.classList.add('hidden');
  downloadImageBtn.disabled = true;
  warnings.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = '正在提取…';
  showStatus('正在读取公开分享页并解析对话数据…');

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input.value.trim() })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `请求失败 (${response.status})`);

    latest = body.data;
    title.textContent = latest.title || 'ChatGPT 分享对话';
    const parts = [];
    if (latest.messageCount != null) parts.push(`${latest.messageCount} 条消息`);
    if (latest.model) parts.push(`模型：${latest.model}`);
    meta.textContent = parts.join(' · ');
    transcript.textContent = latest.text;

    if (latest.warnings?.length) {
      warnings.textContent = `解析提示：${latest.warnings.join('；')}`;
      warnings.classList.remove('hidden');
    }

    hideStatus();
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    generateLongImage(latest).catch((error) => {
      imageMeta.textContent = error.message || '长图生成失败';
    });
  } catch (error) {
    latest = null;
    showStatus(error.message || '提取失败。', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '提取对话';
  }
});

copyBtn.addEventListener('click', async () => {
  if (!latest?.text) return;
  await navigator.clipboard.writeText(latest.text);
  const old = copyBtn.textContent;
  copyBtn.textContent = '已复制';
  setTimeout(() => { copyBtn.textContent = old; }, 1200);
});

downloadBtn.addEventListener('click', () => {
  if (!latest?.text) return;
  const blob = new Blob([latest.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename(latest.title)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

downloadImageBtn.addEventListener('click', () => {
  if (!latestImageUrl || !latest) return;
  const a = document.createElement('a');
  a.href = latestImageUrl;
  a.download = `${safeFilename(latest.title)}-ChatGPT.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});
