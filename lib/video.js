// Cloudflare Stream wrapper — video upload + private playback.
//
// Why Stream and not "save the file ourselves": phone videos are big (100–500MB)
// and often HEVC/.mov, which Chrome won't play. Stream takes a direct
// browser->Cloudflare upload (never through our Node server, which would choke
// on the file size), transcodes to H.264/HLS so it plays everywhere, and serves
// it over a CDN.
//
// Privacy: every upload is created with requireSignedURLs=true, so a video is
// NOT viewable by anyone who happens to have its uid. Playback needs a
// short-lived signed token minted server-side for the video's owner. That's
// deliberate — these are people's unguarded, talking-to-themselves recordings.
//
// Fails soft on missing config (like lib/push.js) so the app still boots and
// the routes can return a friendly "not configured" instead of throwing.

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID   || '';
const API_TOKEN  = process.env.CLOUDFLARE_STREAM_TOKEN || '';
const API_BASE   = 'https://api.cloudflare.com/client/v4';

function isVideoConfigured() {
  return !!(ACCOUNT_ID && API_TOKEN);
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${API_TOKEN}`, ...extra };
}

// Cloudflare wraps everything in { success, result, errors }. Normalize that
// into either the result or a thrown Error carrying their message.
async function cf(path, options = {}) {
  const res = await fetch(`${API_BASE}/accounts/${ACCOUNT_ID}${path}`, options);
  let body;
  try {
    body = await res.json();
  } catch (_) {
    throw new Error(`Cloudflare returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || !body.success) {
    const detail = (body.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ')
      || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body.result;
}

// Mint a one-time upload URL. The browser POSTs the file straight to this URL
// as multipart/form-data (field name "file") — our server never touches the
// bytes. `creator` tags the video with the owning user id, which is handy in
// the Cloudflare dashboard and for future per-user queries.
async function createDirectUpload({ userId, name, maxDurationSeconds = 3600 } = {}) {
  const result = await cf('/stream/direct_upload', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      maxDurationSeconds,
      requireSignedURLs: true,
      creator: userId ? String(userId) : undefined,
      meta: name ? { name } : undefined,
    }),
  });
  return { uploadURL: result.uploadURL, uid: result.uid };
}

// Video details — status.state is 'inprogress' | 'ready' | 'error'. We use
// readyToStream to decide whether to show a player or a "still processing" note.
async function getVideo(uid) {
  return cf(`/stream/${encodeURIComponent(uid)}`, { headers: authHeaders() });
}

// Short-lived signed token for private playback. Without this, a
// requireSignedURLs video refuses to play at all.
async function getPlaybackToken(uid, { expSeconds = 3600 } = {}) {
  const result = await cf(`/stream/${encodeURIComponent(uid)}/token`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSeconds }),
  });
  return result.token;
}

async function deleteVideo(uid) {
  return cf(`/stream/${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
}

// Cheapest call that proves account id + token + Stream permissions are all
// good. Returns the (possibly empty) list of videos.
async function listVideos(limit = 1) {
  return cf(`/stream?limit=${encodeURIComponent(limit)}`, { headers: authHeaders() });
}

// The playback host is account-specific (customer-<code>.cloudflarestream.com).
// Rather than make it another env var to get wrong, derive it from a video's
// own preview/playback URL, which Cloudflare returns on the video record.
function customerHostFromVideo(video) {
  const candidate = (video && (video.preview || (video.playback && video.playback.hls))) || '';
  const m = candidate.match(/https:\/\/([^/]+)\//);
  return m ? m[1] : null;
}

module.exports = {
  isVideoConfigured,
  createDirectUpload,
  getVideo,
  getPlaybackToken,
  deleteVideo,
  listVideos,
  customerHostFromVideo,
  // exported for the admin diagnostic
  _accountConfigured: () => ({ accountId: !!ACCOUNT_ID, token: !!API_TOKEN }),
};
