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

let latest = null;

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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.classList.add('hidden');
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
