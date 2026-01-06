// .github/scripts/check_and_post.js
// Fetches latest from Rockstar Graph API and optionally posts to Discord webhook with image embed.

const path = require('path');
const https = require('https');

const repoRoot = path.join(__dirname, '..', '..');
const repoNewswire = require(path.join(repoRoot, 'src', 'newswire'));
const getHashToken = repoNewswire.getHashToken;

const mainLink = 'https://graph.rockstargames.com?';

// Helper to make GET request and parse JSON
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

// Try to find best preview image from the post object
function findPreviewImage(post) {
  if (!post) return null;
  try {
    // Common structure used in the project
    const preview = post.preview_images_parsed;
    if (preview && preview.newswire_block) {
      // prefer widescreen d16x9 if present, then other keys
      const block = preview.newswire_block;
      if (block.d16x9) return ensureAbsolute(block.d16x9);
      // try first available value
      const vals = Object.values(block).filter(v => !!v);
      if (vals.length) return ensureAbsolute(vals[0]);
    }

    // sometimes top-level keys exist
    if (post.img) return ensureAbsolute(post.img);
    if (post.image) return ensureAbsolute(post.image);
    if (post.hero_image) return ensureAbsolute(post.hero_image);
    if (post.preview) {
      // preview might be html; try to extract first src attribute
      const m = post.preview.match(/<img[^>]+src="([^">]+)"/);
      if (m) return ensureAbsolute(m[1]);
    }

    // nothing found
    return null;
  } catch (e) {
    return null;
  }
}

// Make sure image URL is absolute and https
function ensureAbsolute(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return 'https://media-rockstargames-com.akamaized.net' + url;
  return url;
}

// Optionally fetch full article (NewswirePost) to try to locate images within article content
async function fetchFullArticle(id) {
  // This sha is taken from repository code for NewswirePost persisted query
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
  } catch (e) {
    // ignore fetch errors
  }
  return null;
}

async function main() {
  const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
  const FORCE = (process.env.FORCE || 'false').toLowerCase() === 'true';
  const GENRE = process.env.GENRE || 'gta_online';

  if (!DISCORD_WEBHOOK) {
    console.log('[WARN] DISCORD_WEBHOOK not set — script will only log found entries.');
  }

  console.log('[INFO] Fetching persistedQuery SHA (puppeteer)...');
  let sha;
  try {
    sha = await getHashToken();
    console.log('[INFO] Obtained SHA.');
  } catch (e) {
    console.error('[ERROR] Failed to get persistedQuery SHA:', e);
    process.exit(1);
  }

  const variables = {
    page: 1,
    tagId: GENRE === 'latest' ? null : ( // null behaves like latest in some requests
      // Use numeric tag for gta_online if specified
      GENRE === 'gta_online' ? 702 : null
    ),
    metaUrl: '/newswire',
    locale: 'en_us'
  };

  const listParams = new URLSearchParams([
    ['operationName', 'NewswireList'],
    ['variables', JSON.stringify(variables)],
    ['extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: sha } })]
  ]);

  const url = mainLink + listParams.toString();
  console.log('[INFO] Requesting Graph endpoint:', url);

  let json;
  try {
    json = await fetchJson(url);
  } catch (e) {
    console.error('[ERROR] Graph request failed:', e);
    process.exit(1);
  }

  if (!json || !json.data || !json.data.posts || !json.data.posts.results) {
    console.log('[INFO] No posts returned by the Graph API.');
    process.exit(0);
  }

  const results = json.data.posts.results;
  console.log('[INFO] Found', results.length, 'results. First result title:', results[0] && results[0].title);

  const top = results[0];
  const link = 'https://www.rockstargames.com' + (top.url || '');
  const title = top.title || 'No title';
  const preview = (top.preview || top.title || '').replace(/<\/?[^>]+(>|$)/g, '').substring(0, 1200);

  // Try to find preview image
  let imageUrl = findPreviewImage(top);
  if (!imageUrl) {
    console.log('[INFO] No preview image in list item; attempting to fetch full article for images...');
    const full = await fetchFullArticle(top.id);
    if (full) {
      imageUrl = findPreviewImage(full) || null;
      if (!imageUrl) {
        // try scanning tina payload for first image entry (simple approach)
        try {
          const imgBase = 'https://media-rockstargames-com.akamaized.net';
          const content = full.tina && full.tina.payload && full.tina.payload.content;
          if (content) {
            const str = JSON.stringify(content);
            const m = str.match(/"sources"\s*:\s*{[^}]*"en_us"[^}]*"(desktop|mobile)"\s*:\s*"([^"]+)"/);
            if (m && m[2]) imageUrl = ensureAbsolute(m[2]);
          }
        } catch (e) { /* ignore */ }
      }
    }
  }

  console.log('[DEBUG] imageUrl:', imageUrl || '<none found>');

  // Build embed
  const embed = {
    author: { name: 'Rockstar Newswire', url: 'https://www.rockstargames.com/newswire', icon_url: 'https://yt3.googleusercontent.com/-jCZaDR8AoEgC6CBPWFubF2PMSOTGU3nJ4VOSo7aq3W6mR8tcRCgygd8fS-4Ra41oHPo3F3P=s900-c-k-c0x00ffffff-no-rj' },
    title,
    url: link,
    description: preview,
    color: 16756992,
    footer: { text: (top.primary_tags && Array.isArray(top.primary_tags) ? top.primary_tags.map(t => t.name).join(', ') : '') }
  };

  if (imageUrl) {
    embed.image = { url: imageUrl };
    // optionally also set thumbnail using a small version if you have it
    // embed.thumbnail = { url: thumbnailUrl };
  }

  const payload = {
    username: 'Rockstar Newswire Tracker (Actions)',
    embeds: [embed]
  };

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
    } catch (e) {
      console.error('[ERROR] Failed to post to Discord webhook:', e);
      process.exit(1);
    }
  } else {
    console.log('[INFO] Not posting to Discord (set DISCORD_WEBHOOK and run with FORCE=true to post).');
  }

  process.exit(0);
}

main();
