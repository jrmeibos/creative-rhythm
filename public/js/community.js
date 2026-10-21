/* Cohort room — feed (posts/comments/reactions) + progress-grid drawer. */

// ── Helpers ─────────────────────────────────────────────────────────────────
async function cr_fetch(url, method, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, data };
}

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return ts;
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24); if (days < 7) return days + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

document.querySelectorAll('time[data-ts]').forEach(t => {
  const pretty = relTime(t.getAttribute('data-ts'));
  if (pretty) { t.textContent = pretty; t.title = t.getAttribute('data-ts'); }
});

// ── Tabs ────────────────────────────────────────────────────────────────────
const tabs = document.querySelectorAll('.room-tab');
function showTab(name) {
  tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
  const feed = document.getElementById('panel-feed');
  const prog = document.getElementById('panel-progress');
  if (feed) feed.hidden = name !== 'feed';
  if (prog) prog.hidden = name !== 'progress';
}
tabs.forEach(t => t.addEventListener('click', () => {
  showTab(t.dataset.tab);
  try { history.replaceState(null, '', '#' + t.dataset.tab); } catch (_) {}
}));
if (location.hash === '#progress') showTab('progress');

// ── Cohort switcher (admin) ─────────────────────────────────────────────────
const switcher = document.getElementById('cohort-switch');
if (switcher) {
  switcher.addEventListener('change', () => {
    window.location.href = '/community?cohort=' + encodeURIComponent(switcher.value);
  });
}

// ── Composer: new post ──────────────────────────────────────────────────────
const postSubmit = document.getElementById('post-submit');
if (postSubmit) {
  postSubmit.addEventListener('click', async () => {
    const input = document.getElementById('post-input');
    const content = input.value.trim();
    if (!content) return;
    postSubmit.disabled = true;
    const body = { content };
    const cid = postSubmit.getAttribute('data-cohort-id');
    if (cid) body.cohortId = parseInt(cid, 10);
    const { ok, data } = await cr_fetch('/api/community/posts', 'POST', body);
    if (!ok) { alert(data.error || 'Could not post.'); postSubmit.disabled = false; return; }
    location.reload();
  });
}

// ── Delegated actions on the feed ───────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  // Reactions (optimistic — no reload)
  if (btn.classList.contains('react-btn')) {
    const postId = btn.getAttribute('data-post-id');
    const reaction = btn.getAttribute('data-reaction');
    const countEl = btn.querySelector('.react-count');
    const wasOn = btn.classList.contains('is-on');
    // optimistic flip
    btn.classList.toggle('is-on', !wasOn);
    if (countEl) countEl.textContent = Math.max(0, parseInt(countEl.textContent, 10) + (wasOn ? -1 : 1));
    const { ok, data } = await cr_fetch('/api/community/posts/' + postId + '/react', 'POST', { reaction });
    if (!ok) { // revert
      btn.classList.toggle('is-on', wasOn);
      if (countEl) countEl.textContent = Math.max(0, parseInt(countEl.textContent, 10) + (wasOn ? 1 : -1));
      alert(data.error || 'Could not react.');
    } else if (countEl && typeof data.on === 'boolean' && data.on === wasOn) {
      // server disagreed with our optimistic guess — trust it
      btn.classList.toggle('is-on', data.on);
    }
    return;
  }

  // Toggle a post's comment section
  if (btn.classList.contains('comment-toggle')) {
    const sec = document.getElementById('comments-' + btn.getAttribute('data-post-id'));
    if (sec) sec.hidden = !sec.hidden;
    return;
  }

  const action = btn.getAttribute('data-action');
  if (!action) return;

  if (action === 'reply-toggle') {
    const box = document.getElementById('reply-' + btn.getAttribute('data-comment-id'));
    if (box) { box.hidden = !box.hidden; const ta = box.querySelector('textarea'); if (!box.hidden && ta) ta.focus(); }
    return;
  }

  if (action === 'comment-submit') {
    const ta = btn.closest('.comment-composer').querySelector('.comment-input');
    const content = ta.value.trim();
    if (!content) return;
    btn.disabled = true;
    const { ok, data } = await cr_fetch('/api/community/posts/' + btn.getAttribute('data-post-id') + '/comments', 'POST', { content });
    if (!ok) { alert(data.error || 'Could not comment.'); btn.disabled = false; return; }
    location.reload();
    return;
  }

  if (action === 'reply-submit') {
    const ta = btn.closest('.reply-box').querySelector('.reply-input');
    const content = ta.value.trim();
    if (!content) return;
    btn.disabled = true;
    const { ok, data } = await cr_fetch('/api/community/posts/' + btn.getAttribute('data-post-id') + '/comments', 'POST',
      { content, parentCommentId: parseInt(btn.getAttribute('data-parent-id'), 10) });
    if (!ok) { alert(data.error || 'Could not reply.'); btn.disabled = false; return; }
    location.reload();
    return;
  }

  if (action === 'delete-post') {
    if (!confirm('Delete this post? Its comments go with it.')) return;
    const { ok, data } = await cr_fetch('/api/community/posts/' + btn.getAttribute('data-post-id'), 'DELETE');
    if (!ok) { alert(data.error || 'Could not delete.'); return; }
    location.reload();
    return;
  }

  if (action === 'delete-comment') {
    if (!confirm('Delete this comment?')) return;
    const { ok, data } = await cr_fetch('/api/community/comments/' + btn.getAttribute('data-comment-id'), 'DELETE');
    if (!ok) { alert(data.error || 'Could not delete.'); return; }
    location.reload();
    return;
  }

  if (action === 'pin') {
    const pinned = btn.getAttribute('data-pinned') === '1';
    const { ok, data } = await cr_fetch('/api/community/posts/' + btn.getAttribute('data-post-id') + '/pin', 'POST', { pinned: !pinned });
    if (!ok) { alert(data.error || 'Could not pin.'); return; }
    location.reload();
    return;
  }
});

// ── Progress-grid drawer (second tab) ───────────────────────────────────────
const cards       = document.querySelectorAll('.comm-card');
const drawer      = document.getElementById('comm-drawer');
const drawerName  = document.getElementById('comm-drawer-name');
const drawerClose = document.getElementById('comm-drawer-close');
let activeUser    = null;

function openPanel(userId, name) {
  if (!drawer) return;
  activeUser = userId;
  drawer.removeAttribute('hidden');
  if (drawerName) drawerName.textContent = name;
  document.querySelectorAll('.comm-panel').forEach(p => { p.hidden = p.dataset.userId !== userId; });
  cards.forEach(c => {
    const active = c.dataset.userId === userId;
    c.classList.toggle('is-active', active);
    c.setAttribute('aria-expanded', active ? 'true' : 'false');
  });
  setTimeout(() => drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}
function closeDrawer() {
  activeUser = null;
  if (drawer) drawer.setAttribute('hidden', '');
  cards.forEach(c => { c.classList.remove('is-active'); c.setAttribute('aria-expanded', 'false'); });
}
cards.forEach(card => {
  card.addEventListener('click', () => {
    if (card.dataset.userId === activeUser) closeDrawer();
    else openPanel(card.dataset.userId, card.dataset.name);
  });
});
drawerClose?.addEventListener('click', closeDrawer);
