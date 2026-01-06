// .github/scripts/check_and_post.js
// Debug-enhanced: fetch latest Newswire item, extract in-article headlines, post embed to Discord,
// with fallback to put headlines into description if embed field cannot be used.
// Also updates .github/last_posted.json to avoid reposts.

const path = require('path');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const repoNewswire = require(path.join(repoRoot, 'src', 'newswire'));
const getHashToken = repoNewswire.getHashToken;

const mainLink = 'https://graph.rockstargames.com?';
const LAST_FILE = path.join(repoRoot, '.github', 'last_posted.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function ensureAbsolute(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return 'https://media-rockstargames-com.akamaized.net' + url;
  return url;
}

function findPreviewImage(post) {
  if (!post) return null;
  try {
    const preview = post.preview_images_parsed;
    if (preview && preview.newswire_block) {
      const block = preview.newswire_block;
      if (block.d16x9) return ensureAbsolute(block.d16x9);
      const vals = Object.values(block).filter(v => !!v);
      if (vals.length) return ensureAbsolute(vals[0]);
    }
    if (post.img) return ensureAbsolute(post.img);
    if (post.image) return ensureAbsolute(post.image);
    if (post.hero_image) return ensureAbsolute(post.hero_image);
    if (post.preview) {
      const m = post.preview.match(/<img[^>]+src="([^">]+)"/);
      if (m) return ensureAbsolute(m[1]);
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function fetchFullArticle(id) {
  const sha = '555658813abe5acc8010de1a1feddd6fd8fddffbdc35d3723d4dc0fe4ded6810';
  const variables = { locale: 'en_us', id_hash: id };
  const searchParams = new URLSearchParams([
    ['operationName', 'NewswirePost'],
    ['variables', JSON.stringify(variables)],
    ['extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: sha } })]
  ]);
  const url = mainLink + searchParams.toString();
  try {
    const json = await fetchJson(url);
    if (json && json.data && json.data.post) return json.data.post;
  } catch (e) { /* ignore */ }
  return null;
}

// HEADLINE EXTRACTION
function extractHeadlinesFromPost(post, maxCount = 6) {
  const headlines = [];
  const seen = new Set();

  function pushHeadline(text) {
    if (!text) return;
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    headlines.push(clean);
  }

  function traverse(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(traverse); return; }
    if (typeof node === 'string') return;

    if (node._memoq && node._memoq.title) pushHeadline(node._memoq.title);
    if (node._memoq && node._memoq.subtitle) pushHeadline(node._memoq.subtitle);
    if (node.title && typeof node.title === 'string') pushHeadline(node.title);
    if (node.heading && typeof node.heading === 'string') pushHeadline(node.heading);

    if (node._template === 'HTMLElement' && node._memoq && node._memoq.content) {
      extractFromHtml(node._memoq.content).forEach(pushHeadline);
    }

    if (node.items && Array.isArray(node.items)) {
      node.items.forEach(item => {
        if (item.caption) pushHeadline(item.caption);
        if (item.title) pushHeadline(item.title);
        if (item.embed) {
          const matches = (item.embed.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi) || []);
          matches.forEach(m => {
            const t = m.replace(/<[^>]+>/g, '');
            pushHeadline(t);
          });
        }
      });
    }

    ['content', 'children', 'items', 'images'].forEach(k => {
      if (node[k]) traverse(node[k]);
    });

    for (const k of Object.keys(node)) {
      if (['_template','_memoq'].includes(k)) continue;
      const v = node[k];
      if (v && typeof v === 'object') traverse(v);
    }
  }

  function extractFromHtml(html) {
    if (!html || typeof html !== 'string') return [];
    const results = [];
    const hMatches = html.match(/<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi) || [];
    hMatches.forEach(m => {
      const t = m.replace(/<[^>]+>/g, '').trim();
      if (t) results.push(t);
    });
    const sMatches = html.match(/<(strong|b)[^>]*>([^<]{10,}?)<\/(strong|b)>/gi) || [];
    sMatches.forEach(m => {
      const t = m.replace(/<[^>]+>/g, '').trim();
      if (t && t.length < 200) results.push(t);
    });
    return results;
  }

  try {
    if (post.tina && post.tina.payload) {
      const meta = post.tina.payload.meta;
      if (meta) {
        if (meta.subtitle) pushHeadline(meta.subtitle);
        if (meta.title) pushHeadline(meta.title);
      }
      traverse(post.tina.payload.content);
    }
    if (post.preview) {
      extractFromHtml(post.preview).forEach(pushHeadline);
    }
  } catch (e) { /* ignore */ }

  return headlines.slice(0, maxCount);
}

function buildFieldValue(lines, maxLen = 1024) {
  if (!lines || lines.length === 0) return null;
  const joined = lines.map(l => `- ${l}`).join('\n');
  if (joined.length <= maxLen) return joined;
  let truncated = joined.slice(0, maxLen - 2);
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > 0) truncated = truncated.slice(0, lastNewline);
  return truncated + '\n…';
}

function buildExtrasField(results, maxCount) {
  const extras = results.slice(1, 1 + maxCount);
  if (!extras || extras.length === 0) return null;
  const lines = extras.map(item => {
    const title = (item.title || 'No title').replace(/\n/g, ' ').trim();
    const link = 'https://www.rockstargames.com' + (item.url || '');
    return `- ${title} — <${link}>`;
  });
  return buildFieldValue(lines, 1024);
}

// last_posted helpers
function readLastPosted() {
  try {
    if (!fs.existsSync(LAST_FILE)) return {};
    const txt = fs.readFileSync(LAST_FILE, 'utf8');
    return txt ? JSON.parse(txt) : {};
  } catch (e) { return {}; }
}
function writeLastPosted(obj) {
  try {
    fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
    fs.writeFileSync(LAST_FILE, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('[ERROR] Failed to write last_posted file:', e); return false; }
}
function commitAndPushLastPosted() {
  try {
    execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    execSync('git config user.name "github-actions[bot]"');
    execSync(`git add ${LAST_FILE}`);
    try { execSync('git commit -m "chore: update last_posted.json (newsbot)"'); } catch (e) { /* nothing to commit */ }
    execSync('git push --no-verify');
    console.log('[INFO] Committed and pushed last_posted.json');
  } catch (e) {
    console.error('[WARN] Failed to commit/push last_posted.json:', e.message);
  }
}

async function main() {
  const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
  const FORCE = (process.env.FORCE || 'false').toLowerCase() === 'true';
  const GENRE = process.env.GENRE || 'gta_online';
  const EXTRA_COUNT = parseInt(process.env.EXTRA_COUNT || '3', 10) || 3;
  const HEADLINE_COUNT = parseInt(process.env.HEADLINE_COUNT || '6', 10) || 6;

  if (!DISCORD_WEBHOOK) console.log('[WARN] DISCORD_WEBHOOK not set — will only log.');

  console.log('[INFO] Fetching persistedQuery SHA (puppeteer)...');
  let sha;
  try { sha = await getHashToken(); console.log('[INFO] Obtained SHA.'); }
  catch (e) { console.error('[ERROR] Failed to get persistedQuery SHA:', e); process.exit(1); }

  const variables = { page: 1, tagId: GENRE === 'latest' ? null : (GENRE === 'gta_online' ? 702 : null), metaUrl: '/newswire', locale: 'en_us' };
  const listParams = new URLSearchParams([
    ['operationName', 'NewswireList'],
    ['variables', JSON.stringify(variables)],
    ['extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: sha } })]
  ]);
  const url = mainLink + listParams.toString();
  console.log('[INFO] Requesting Graph endpoint:', url);

  let json;
  try { json = await fetchJson(url); } catch (e) { console.error('[ERROR] Graph request failed:', e); process.exit(1); }
  if (!json || !json.data || !json.data.posts || !json.data.posts.results) { console.log('[INFO] No posts returned'); process.exit(0); }

  const results = json.data.posts.results;
  console.log('[INFO] Found', results.length, 'results. First result title:', results[0] && results[0].title);

  const top = results[0];
  const topId = String(top.id);
  console.log('[INFO] Top article id:', topId);

  // dedupe
  const lastPosted = readLastPosted();
  if (!FORCE && lastPosted[GENRE] && lastPosted[GENRE] === topId) {
    console.log('[INFO] Top article already posted for genre', GENRE, '- skipping.');
    process.exit(0);
  }

  // build main payload
  const title = top.title || 'No title';
  const link = 'https://www.rockstargames.com' + (top.url || '');
  let preview = (top.preview || top.title || '').replace(/<\/?[^>]+(>|$)/g, '').substring(0, 1200);
  let imageUrl = findPreviewImage(top);

  // fetch full article for images & internal headlines
  let full = null;
  try {
    full = await fetchFullArticle(top.id);
    console.log('[DEBUG] fetchFullArticle returned', full ? 'OK' : 'null/empty');
    if (full && !imageUrl) imageUrl = findPreviewImage(full);
  } catch (e) { console.log('[WARN] fetchFullArticle error', e.message); }

  const internalHeadlines = extractHeadlinesFromPost(full || top, HEADLINE_COUNT);
  console.log('[DEBUG] extracted internal headlines (count=' + internalHeadlines.length + '):', internalHeadlines);

  const internalFieldValue = buildFieldValue(internalHeadlines, 1024);
  console.log('[DEBUG] internalFieldValue length:', internalFieldValue ? internalFieldValue.length : 0, 'value preview:', internalFieldValue ? internalFieldValue.slice(0,200) : '<none>');

  const extrasField = buildExtrasField(results, EXTRA_COUNT) || null;
  console.log('[DEBUG] extrasField length:', extrasField ? extrasField.length : 0);

  const embed = {
    author: { name: 'Rockstar Newswire', url: 'https://www.rockstargames.com/newswire' },
    title,
    url: link,
    description: preview,
    color: 16756992,
    fields: []
  };
  if (imageUrl) embed.image = { url: imageUrl };

  // Prefer to add as a field; if not possible, append to description as fallback
  if (internalFieldValue) {
    embed.fields.push({ name: 'Headlines inside the article', value: internalFieldValue, inline: false });
  } else if (internalHeadlines && internalHeadlines.length) {
    // fallback: append a short list to description
    const short = internalHeadlines.slice(0, 6).map(h => `• ${h}`).join('\n');
    const append = '\n\nHeadlines inside the article:\n' + (short.length > 800 ? short.slice(0, 800) + '\n…' : short);
    embed.description = (embed.description || '') + append;
  } else {
    console.log('[DEBUG] No internal headlines found to include.');
  }

  if (extrasField) embed.fields.push({ name: 'What else is new', value: extrasField, inline: false });

  const payload = { username: 'Rockstar Newswire Tracker (Actions)', embeds: [embed] };
  console.log('[DEBUG] payload preview:', JSON.stringify(payload).slice(0,1500));

  // post
  if (DISCORD_WEBHOOK) {
    try {
      const resp = await new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const u = new URL(DISCORD_WEBHOOK);
        const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
        const req = https.request(u, opts, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
      console.log('[INFO] Discord response:', resp.statusCode, resp.body || '<no body>');
      if (resp.statusCode >= 400) { console.error('[ERROR] Discord returned error — not updating last_posted.json'); process.exit(1); }

      // update last_posted.json and push
      lastPosted[GENRE] = topId;
      if (writeLastPosted(lastPosted)) commitAndPushLastPosted();
    } catch (e) {
      console.error('[ERROR] Failed to post to Discord webhook:', e);
      process.exit(1);
    }
  } else {
    console.log('[INFO] DISCORD_WEBHOOK not set; would post payload.', JSON.stringify(payload).slice(0,800));
    lastPosted[GENRE] = topId;
    writeLastPosted(lastPosted);
  }

  process.exit(0);
}

main();
