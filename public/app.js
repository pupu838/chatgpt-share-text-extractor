import { paginateLayouts, imagePageHeight, MAX_PAGE_HEIGHT, IMAGE_WIDTH, HEADER_HEIGHT, MESSAGE_GAP } from './pagination.js';
import { createZip } from './zip.js';
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
const imageGallery = document.querySelector('#imageGallery');

let latest = null;
let latestImages = [];
let generationNumber = 0;
function clearImages() {
  for (const entry of latestImages) URL.revokeObjectURL(entry.url);
  latestImages = [];
  imageGallery.replaceChildren();
}

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
  if (!String(text).trim()) return [];
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

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ kind: 'image', element: image, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = `/api/media?url=${encodeURIComponent(url)}`;
  });
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';
    const timer = setTimeout(() => reject(new Error('video timeout')), 8000);
    video.addEventListener('loadeddata', () => {
      clearTimeout(timer);
      resolve({ kind: 'video', element: video, width: video.videoWidth, height: video.videoHeight });
    }, { once: true });
    video.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('video unavailable'));
    }, { once: true });
    video.src = `/api/media?url=${encodeURIComponent(url)}`;
  });
}

async function loadPublicMedia(message) {
  const assets = Array.isArray(message.assets) ? message.assets : [];
  const loaded = await Promise.all(assets.map(async (asset) => {
    if (!/^https:\/\//i.test(asset?.url || '')) return null;
    const isVideo = asset.assetType === 'video' || /\.(?:mp4|webm|mov|m4v)(?:$|\?)/i.test(asset.filename || asset.url);
    try {
      return isVideo ? await loadVideo(asset.url) : await loadImage(asset.url);
    } catch {
      return null;
    }
  }));
  return loaded.filter(Boolean);
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

function layoutMessage(ctx, message, contentWidth, media = []) {
  const isUser = message.role === 'user';
  const fontSize = 27;
  const lineHeight = 43;
  ctx.font = `${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif`;
  const maxTextWidth = isUser ? 650 : contentWidth - 78;
  const label = message.section && !['user', 'answer'].includes(message.section) ? '[' + (message.displayRole || '过程') + ']\n' : '';
  const lines = wrapLines(ctx, label + cleanMarkdown(message.text || ''), maxTextWidth);
  const paddingY = isUser ? 22 : 4;
  const mediaItems = media.map((item) => {
    const width = Math.min(650, item.width || 650);
    const height = Math.min(540, Math.round(width * (item.height || 1) / (item.width || 1)));
    return { ...item, drawWidth: width, drawHeight: height };
  });
  const mediaHeight = mediaItems.reduce((sum, item) => sum + item.drawHeight + 14, 0);
  const textHeight = lines.length * lineHeight;
  return {
    isUser, lines, lineHeight, maxTextWidth, media: mediaItems,
    height: Math.max(48, textHeight + mediaHeight + paddingY * 2)
  };
}

async function generateLongImage(data) {
  const generation = ++generationNumber;
  clearImages();
  imageResult.classList.remove('hidden');
  imageMeta.textContent = '正在测量内容长度…';
  downloadImageBtn.disabled = true;

  await document.fonts?.ready;
  const width = IMAGE_WIDTH;
  const side = 112;
  const contentWidth = width - side * 2;
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('浏览器不支持 Canvas 画布。');
  const mediaByMessage = await Promise.all((data.messages || []).map(loadPublicMedia));
  if (generation !== generationNumber) return;
  const layouts = (data.messages || []).map((message, index) =>
    layoutMessage(measure, message, contentWidth, mediaByMessage[index]));
  const pages = paginateLayouts(layouts);
  const headerHeight = HEADER_HEIGHT;
  const gap = MESSAGE_GAP;
  const fileBase = safeFilename(data.title);

  async function drawPage(page, pageIndex, totalPages) {
    const naturalHeight = Math.ceil(imagePageHeight(page));
    if (naturalHeight > MAX_PAGE_HEIGHT) throw new Error('长图分页超过像素限制。');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器无法生成长图。');
    ctx.fillStyle = '#fff';
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
  page.forEach((fragment) => {
    const layout = fragment.layout;
    const message = data.messages[fragment.messageIndex];
    ctx.font = '27px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'top';
    if (layout.isUser) {
      const widestText = layout.lines.length ? Math.max(...layout.lines.map((line) => ctx.measureText(line).width)) : 0;
      const widestMedia = layout.media.length ? Math.max(...layout.media.map((item) => item.drawWidth)) : 0;
      const widest = Math.min(layout.maxTextWidth, Math.max(widestText, widestMedia, 40));
      const bubbleWidth = widest + 54;
      const x = width - side - bubbleWidth;
      ctx.fillStyle = '#f4f4f4';
      roundedRect(ctx, x, y, bubbleWidth, layout.height, 28);
      let contentY = y + 22;
      layout.media.forEach((item) => {
        const mediaX = x + bubbleWidth - 27 - item.drawWidth;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(mediaX, contentY, item.drawWidth, item.drawHeight, 18);
        ctx.clip();
        ctx.drawImage(item.element, mediaX, contentY, item.drawWidth, item.drawHeight);
        ctx.restore();
        if (item.kind === 'video') drawPlayButton(ctx, mediaX + item.drawWidth / 2, contentY + item.drawHeight / 2);
        contentY += item.drawHeight + 14;
      });
      ctx.fillStyle = '#0d0d0d';
      layout.lines.forEach((line, lineIndex) => ctx.fillText(line, x + 27, contentY + lineIndex * layout.lineHeight));
    } else {
      drawChatGptMark(ctx, side + 22, y + 24);
      let contentY = y + 4;
      layout.media.forEach((item) => {
        const mediaX = side + 72;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(mediaX, contentY, item.drawWidth, item.drawHeight, 18);
        ctx.clip();
        ctx.drawImage(item.element, mediaX, contentY, item.drawWidth, item.drawHeight);
        ctx.restore();
        if (item.kind === 'video') drawPlayButton(ctx, mediaX + item.drawWidth / 2, contentY + item.drawHeight / 2);
        contentY += item.drawHeight + 14;
      });
      ctx.fillStyle = '#0d0d0d';
      layout.lines.forEach((line, lineIndex) => ctx.fillText(line, side + 72, contentY + lineIndex * layout.lineHeight));
    }
    y += layout.height + gap;
  });

  ctx.fillStyle = '#9b9b9b';
  ctx.font = '19px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Generated from a public ChatGPT share link', side, naturalHeight - 48);
  ctx.textAlign = 'right';
  ctx.fillText((pageIndex + 1) + ' / ' + totalPages, width - side, naturalHeight - 48);


    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 图片生成失败')), 'image/png');
    });
  }

  for (let i = 0; i < pages.length; i++) {
    if (generation !== generationNumber) return;
    imageMeta.textContent = '正在生成第 ' + (i + 1) + ' / ' + pages.length + ' 张…';
    const blob = await drawPage(pages[i], i, pages.length);
    if (generation !== generationNumber) return;
    const url = URL.createObjectURL(blob);
    const filename = fileBase + '-ChatGPT-' + String(i + 1).padStart(2, '0') + '.png';
    latestImages.push({ blob, url, filename });

    const article = document.createElement('article');
    article.className = 'image-page';
    const heading = document.createElement('div');
    heading.className = 'page-heading';
    const headingTitle = document.createElement('strong');
    headingTitle.textContent = '长图 ' + (i + 1) + ' / ' + pages.length;
    const action = document.createElement('button');
    action.className = 'secondary';
    action.type = 'button';
    action.textContent = '下载这一张 PNG';
    action.addEventListener('click', () => downloadBlob(blob, filename));
    heading.append(headingTitle, action);
    const preview = document.createElement('div');
    preview.className = 'image-preview';
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.src = url;
    image.alt = '对话长图第 ' + (i + 1) + ' 张';
    preview.append(image);
    article.append(heading, preview);
    imageGallery.append(article);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  imageMeta.textContent = '共 ' + latestImages.length + ' 张，每张宽 ' + width + 'px，最高 ' + MAX_PAGE_HEIGHT + 'px，不压缩缩小';
  downloadImageBtn.textContent = latestImages.length > 1 ? '打包下载全部 ' + latestImages.length + ' 张 ZIP' : '下载长图 PNG';
  downloadImageBtn.disabled = latestImages.length === 0;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function drawPlayButton(ctx, x, y) {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, .66)';
  ctx.beginPath();
  ctx.arc(x, y, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(x - 10, y - 16);
  ctx.lineTo(x + 18, y);
  ctx.lineTo(x - 10, y + 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  generationNumber++;
  clearImages();
  result.classList.add('hidden');
  imageResult.classList.add('hidden');
  downloadImageBtn.disabled = true;
  downloadImageBtn.textContent = '下载长图 PNG';
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

downloadImageBtn.addEventListener('click', async () => {
  if (!latestImages.length || !latest) return;
  downloadImageBtn.disabled = true;
  try {
    if (latestImages.length === 1) {
      downloadBlob(latestImages[0].blob, latestImages[0].filename);
    } else {
      imageMeta.textContent = '正在打包 ZIP…';
      const archive = await createZip(latestImages.map(image => ({
        name: image.filename, blob: image.blob
      })));
      downloadBlob(archive, safeFilename(latest.title) + '-ChatGPT-全部长图.zip');
      imageMeta.textContent = '共 ' + latestImages.length + ' 张长图，已准备下载';
    }
  } catch (error) {
    imageMeta.textContent = error?.message || '打包失败，请单独下载每张 PNG';
  } finally {
    downloadImageBtn.disabled = false;
  }
});
