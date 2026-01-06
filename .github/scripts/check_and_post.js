// .github/scripts/check_and_post.js
// Fetches latest from Rockstar Graph API and optionally posts to Discord webhook with image embed.
// Extracts internal article headings/subtitles from the full article Tina payload and adds them as an embed field.

const path = require('path');
const https = require('https');

const repoRoot = path.join(__dirname, '..', '..');
const repoNewswire = require(path.join(repoRoot, 'src', 'newswire'));
const getHashToken = repoNewswire.getHashToken;

const mainLink = 'https://graph.rockstargames.com?';

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

// Extract headings inside Tina payload or HTML snippets.
// Returns unique headlines in order found (maxCount controls how many).
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

  // Try to extract titles/subtitles from Tina payload recursively
  function traverse(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(traverse);
      return;
    }
    if (typeof node === 'string') {
      // could be plain text; ignore as headline
      return;
    }
    // node._memoq.title is often the display heading inside components
    if (node._memoq && node._memoq.title) pushHeadline(node._memoq.title);
    // subtitle meta
    if (node._memoq && node._memoq.subtitle) pushHeadline(node._memoq.subtitle);

    // Some templates include 'title' property or 'heading' fields
    if (node.title && typeof node.title === 'string') pushHeadline(node.title);
    if (node.heading && typeof node.heading === 'string') pushHeadline(node.heading);

    // If node is HTMLElement and contains HTML string, extract <h1/h2/h3> contents
    if (node._template === 'HTMLElement' && node._memoq && node._memoq.content) {
      const html = node._memoq.content;
      extractFromHtml(html).forEach(pushHeadline);
    }

    // Embed items might have captions
    if (node.items && Array.isArray(node.items)) {
      node.items.forEach(item => {
        if (item.caption) pushHeadline(item.caption);
        if (item.title) pushHeadline(item.title);
        if (item.embed) {
          // try to extract headings from embed iframe/html
          const matches = (item.embed.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi) || []);
          matches.forEach(m => {
            const t = m.replace(/<[^>]+>/g, '');
            pushHeadline(t);
          });
        }
      });
    }

    // Recurse common child keys
    ['content', 'children', 'items', 'images'].forEach(k => {
      if (node[k]) traverse(node[k]);
    });

    // generic keys
    for (const k of Object.keys(node)) {
      if (['_template','_memoq'].includes(k)) continue;
      const v = node[k];
      if (v && typeof v === 'object') traverse(v);
    }
  }

  // Extract headings from HTML strings (h1,h2,h3)
  function extractFromHtml(html) {
    if (!html || typeof html !== 'string') return [];
    const results = [];
    // find <h1..h3> and <strong> styled headings
    const hMatches = html.match(/<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi) || [];
    hMatches.forEach(m => {
      const t = m.replace(/<[^>]+>/g, '').trim();
      if (t) results.push(t);
    });
    // fallback: strong tags that look like headlines
    const sMatches = html.match(/<(strong|b)[^>]*>([^<]{10,}?)<\/(strong|b)>/gi) || [];
    sMatches.forEach(m => {
      const t = m.replace(/<[^>]+>/g, '').trim();
      if (t && t.length < 200) results.push(t);
    });
    return results;
  }

  // Primary sources to inspect:
  // - post.tina.payload.content (structured content)
  // - post.tina.payload.meta (subtitle/title)
  // - post.subtitle or post.title (already used elsewhere)
  try {
    if (post.tina && post.tina.payload) {
      const meta = post.tina.payload.meta;
      if (meta) {
        if (meta.subtitle) pushHeadline(meta.subtitle);
        if (meta.title) pushHeadline(meta.title);
      }
      traverse(post.tina.payload.content);
    }

    // also inspect summary/preview HTML
    if (post.preview) {
      extractFromHtml(post.preview).forEach(pushHeadline);
    }

    // sometimes primary_tags or other fields have useful short titles; ignore for now

  } catch (e) {
    // ignore extraction errors
  }

  // Limit results
  return headlines.slice(0, maxCount);
}

function buildFieldValue(lines, maxLen = 1024) {
  if (!lines || lines.length === 0) return null;
  const joined = lines.map(l => `- ${l}`).join('\n');
  if (joined.length <= maxLen) return joined;
  // truncate safely
  let truncated = joined.slice(0, maxLen - 2);
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > 0) truncated = truncated.slice(0, lastNewline);
  return truncated + '\n…';
}

async function main() {
  const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
  const FORCE = (process.env.FORCE || 'false').toLowerCase() === 'true';
  const GENRE = process.env.GENRE || 'gta_online';
  const EXTRA_COUNT = parseInt(process.env.EXTRA_COUNT || '3', 10) || 3;
  const HEADLINE_COUNT = parseInt(process.env.HEADLINE_COUNT || '6', 10) || 6;

  if (!DISCORD_WEBHOOK) console.log('[WARN] DISCORD_WEBHOOK not set — script will only log found entries.');

  console.log('[INFO] Fetching persistedQuery SHA (puppeteer)...');
  let sha;
  try {
    sha = await getHashToken();
    console.log('[INFO] Obtained SHA.');
  } catch (e) {
    console.error('[ERROR] Failed to get persistedQuery SHA:', e);
    process.exit(1);
  }

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
  if (!json || !json.data || !json.data.posts || !json.data.posts.results) { console.log('[INFO] No posts returned by the Graph API.'); process.exit(0); }

  const results = json.data.posts.results;
  console.log('[INFO] Found', results.length, 'results. First result title:', results[0] && results[0].title);

  const top = results[0];
  const link = 'https://www.rockstargames.com' + (top.url || '');
  const title = top.title || 'No title';
  const preview = (top.preview || top.title || '').replace(/<\/?[^>]+(>|$)/g, '').substring(0, 1200);
  let imageUrl = findPreviewImage(top);

  // fetch full article if needed for image and to extract internal headlines
  let full = null;
  try {
    full = await fetchFullArticle(top.id);
    if (full && !imageUrl) imageUrl = findPreviewImage(full);
  } catch (e) { /* ignore */ }

  const internalHeadlines = extractHeadlinesFromPost(full || top, HEADLINE_COUNT);
  console.log('[DEBUG] extracted internal headlines:', internalHeadlines);

  // `What else is new` extras (other recent items)
  const extrasField = buildExtrasField(results, EXTRA_COUNT) || null;

  // Build embed
  const embed = {
    author: { name: 'Rockstar Newswire', url: 'https://www.rockstargames.com/newswire', icon_url: 'https://yt3.googleusercontent.com/-jCZaDR8AoEgC6CBPWFubF2PMSOTGU3nJ4VOSo7aq3W6mR8tcRCgygd8fS-4Ra41oHPo3F3P=s900-c-k-c0x00ffffff-no-rj' },
    title,
    url: link,
    description: preview,
    color: 16756992,
    footer: { text: (top.primary_tags && Array.isArray(top.primary_tags) ? top.primary_tags.map(t => t.name).join(', ') : '') },
    fields: []
  };

  if (imageUrl) embed.image = { url: imageUrl };

  if (internalHeadlines && internalHeadlines.length) {
    const val = buildFieldValue(internalHeadlines, 1024);
    if (val) embed.fields.push({ name: 'Headlines inside the article', value: val, inline: false });
  }

  if (extrasField) {
    embed.fields.push({ name: 'What else is new', value: extrasField, inline: false });
  }

  const payload = { username: 'Rockstar Newswire Tracker (Actions)', embeds: [embed] };
  console.log('[INFO] Payload preview:', JSON.stringify(payload).slice(0, 1400));

  if (DISCORD_WEBHOOK && (FORCE || process.env.GITHUB_EVENT_NAME === 'schedule')) {
    console.log('[INFO] Posting to Discord webhook.');
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
      if (resp.statusCode >= 400) process.exit(1);
    } catch (e) { console.error('[ERROR] Failed to post to Discord webhook:', e); process.exit(1); }
  } else {
    console.log('[INFO] Not posting to Discord (set DISCORD_WEBHOOK and run with FORCE=true to post).');
  }

  process.exit(0);
}

main();
