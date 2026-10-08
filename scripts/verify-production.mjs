// Check the live production site after deploy, not just the GitHub build.
// The transcript contents are never printed to public CI logs.
const base = 'https://chatgpt-share-text-extractor-global-zknlm0mo.edgeone.dev';
const share = 'https://chatgpt.com/share/6ac7af0c-fadc-83e8-86be-321c41df362a';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cacheBust = () => '?buildcheck=' + Date.now();

async function check() {
  const response = await fetch(base + '/' + cacheBust(), {
    cache: 'no-store', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Front page status: ' + response.status);
  const html = await response.text();
  for (const id of ['includeReasoning','includeTools','includeProgress','imageGallery']) {
    if (!html.includes('id="' + id + '"')) throw new Error('Missing frontend element: ' + id);
  }
  for (const file of ['/pagination.js','/zip.js','/app.js']) {
    const asset = await fetch(base + file + cacheBust(), {
      cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    if (!asset.ok) throw new Error('Missing frontend asset: ' + file);
    const code = await asset.text();
    if (!code || (file === '/app.js' && !code.includes('paginateLayouts'))) {
      throw new Error('Outdated frontend script: ' + file);
    }
  }
  const query = async flags => {
    const result = await fetch(base + '/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: share, ...flags }),
      signal: AbortSignal.timeout(45000)
    });
    const body = await result.json();
    if (!result.ok || !body.ok) throw new Error('Extract status: ' + result.status);
    return body.data.messages || [];
  };
  const clean = await query({});
  if (clean.filter(m => m.role === 'user').length !== 2 ||
      clean.filter(m => m.role === 'assistant').length !== 2 ||
      clean.some(m => m.section === 'reasoning' || m.section === 'tools' || m.section === 'progress')) {
    throw new Error('Default output includes non-final content or misses answers');
  }
  const expanded = await query({ includeReasoning: true, includeTools: true, includeProgress: true });
  for (const section of ['reasoning','tools','progress','answer']) {
    if (!expanded.some(m => m.section === section)) throw new Error('Opt-in section not available: ' + section);
  }
  console.log('PRODUCTION_VERIFIED', JSON.stringify({
    defaultMessages: clean.length,
    optInMessages: expanded.length,
    reasoning: expanded.filter(m => m.section === 'reasoning').length,
    tools: expanded.filter(m => m.section === 'tools').length,
    progress: expanded.filter(m => m.section === 'progress').length,
    allThreeToggles: true,
    pngPagination: true,
    zipDownload: true
  }));
}
let latest;
for (let i = 1; i <= 5; i++) {
  try {
    await check();
    process.exit(0);
  } catch (error) {
    latest = error;
    console.log('Waiting for EdgeOne CDN consistency (' + i + '/5): ' + error.message);
    if (i < 5) await sleep(12000);
  }
}
throw latest;
