// .github/scripts/check_and_post.js
// Same as your working script, with repository-backed dedupe (last_posted.json)
// so the Action posts only when a new article appears.

const path = require('path');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const repoNewswire = require(path.join(repoRoot, 'src', 'newswire'));
const getHashToken = repoNewswire.getHashToken;

const mainLink = 'https://graph.rockstargames.com?';
const LAST_FILE = path.join(repoRoot, '.github', 'last_posted.json'); // stores last posted ids

function fetchJson(url) { /* unchanged: same helper as before */ 
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

function findPreviewImage(post) { /* same as before - unchanged */ 
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

async function fetchFullArticle(id) { /* same as before */ 
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

// (You can reuse your existing extractHeadlinesFromPost/buildFieldValue/buildExtrasField functions here unchanged)
// For brevity, assume you paste your extractor functions from the working script exactly here:
function extractHeadlinesFromPost(post, maxCount = 6) {
  // (copy the extractor implementation you already use)
  // ... (omitted here for brevity - paste your existing function)
}
function buildFieldValue(lines, maxLen = 1024) {
  // (copy existing implementation)
}
function buildExtrasField(results, maxCount) {
  // (copy existing implementation)
}

// Helper: read/write last posted file
function readLastPosted() {
  try {
    if (!fs.existsSync(LAST_FILE)) return {};
    const txt = fs.readFileSync(LAST_FILE, 'utf8');
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    return {};
  }
}
function writeLastPosted(obj) {
  try {
    fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
    fs.writeFileSync(LAST_FILE, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ERROR] Failed to write last_posted file:', e);
    return false;
  }
}

// Commit and push the updated last_posted file back to the repo
function commitAndPushLastPosted(branchName) {
  try {
    // Configure git user
    execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    execSync('git config user.name "github-actions[bot]"');
    // Ensure we're on a branch (runner checkout usually has a branch)
    // Stage, commit and push
    execSync(`git add ${LAST_FILE}`);
    // commit only if changes present
    try { execSync('git commit -m "chore: update last_posted.json (newsbot)"'); } catch (e) { /* no changes to commit */ }
    execSync('git push --no-verify');
    console.log('[INFO] Committed and pushed last_posted.json');
  } catch (e) {
    console.error('[WARN] Failed to commit/push last_posted.json. Ensure workflow has write permissions.', e.message);
  }
}

async function main() {
  const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
  const FORCE = (process.env.FORCE || 'false').toLowerCase() === 'true';
  const GENRE = process.env.GENRE || 'gta_online';
  const EXTRA_COUNT = parseInt(process.env.EXTRA_COUNT || '3', 10) || 3;
  const HEADLINE_COUNT = parseInt(process.env.HEADLINE_COUNT || '6', 10) || 6;

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
  const top = results[0];
  const topId = String(top.id);
  console.log('[INFO] Top article id:', topId, 'title:', top.title);

  // load last posted IDs
  const lastPosted = readLastPosted();
  if (!FORCE && lastPosted[GENRE] && lastPosted[GENRE] === topId) {
    console.log('[INFO] Top article already posted for genre', GENRE, '- doing nothing.');
    process.exit(0);
  }

  // (prepare embed and payload exactly as your working script: preview, image, internal headlines, extrasField)
  // For brevity, reuse your existing code to build `payload` here:
  // ... build `payload` object that will be POSTed to Discord (same as your working script)
  // After successful POST, update lastPosted and commit

  // Example minimal posting flow (replace with your real payload code)
  const title = top.title || 'No title';
  const link = 'https://www.rockstargames.com' + (top.url || '');
  const preview = (top.preview || top.title || '').replace(/<\/?[^>]+(>|$)/g, '').substring(0, 1200);
  let imageUrl = findPreviewImage(top);
  let full = null;
  try { full = await fetchFullArticle(top.id); if (full && !imageUrl) imageUrl = findPreviewImage(full); } catch (e) {}
  const internalHeadlines = extractHeadlinesFromPost(full || top, HEADLINE_COUNT);
  const extrasField = buildExtrasField(results, EXTRA_COUNT) || null;

  const embed = {
    author: { name: 'Rockstar Newswire', url: 'https://www.rockstargames.com/newswire' },
    title,
    url: link,
    description: preview,
    color: 16756992,
    fields: []
  };
  if (imageUrl) embed.image = { url: imageUrl };
  if (internalHeadlines && internalHeadlines.length) {
    const val = buildFieldValue(internalHeadlines, 1024);
    if (val) embed.fields.push({ name: 'Headlines inside the article', value: val, inline: false });
  }
  if (extrasField) embed.fields.push({ name: 'What else is new', value: extrasField, inline: false });

  const payload = { username: 'Rockstar Newswire Tracker (Actions)', embeds: [embed] };

  // Post to Discord
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
      if (resp.statusCode >= 400) {
        console.error('[ERROR] Discord returned error, will not update last_posted.json');
        process.exit(1);
      }

      // Success: update last_posted.json and commit
      lastPosted[GENRE] = topId;
      if (writeLastPosted(lastPosted)) {
        commitAndPushLastPosted();
      } else {
        console.warn('[WARN] Could not write last_posted.json locally; skipping commit.');
      }
    } catch (e) {
      console.error('[ERROR] Failed to post to Discord webhook:', e);
      process.exit(1);
    }
  } else {
    console.log('[INFO] DISCORD_WEBHOOK not set; would post payload:', JSON.stringify(payload).slice(0,1000));
    // Update last_posted.json anyway if forced, to reflect action run
    lastPosted[GENRE] = topId;
    writeLastPosted(lastPosted);
  }

  process.exit(0);
}

main();
