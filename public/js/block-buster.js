/* The Creative Block Buster — flow-chart style. Accordion blocks (feeling →
   ways through), search across blocks, add/remove personal options, add/delete
   own blocks (filed into a category), hide/unhide. Event delegation so
   dynamically-added elements work; saves revert their optimistic UI on error. */
(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error('request failed');
    return res.json();
  }

  const categoriesEl = document.getElementById('bb-categories');
  const chooserEl    = document.getElementById('bb-chooser');
  const searchInput  = document.getElementById('bb-search-input');
  const nomatch      = document.getElementById('bb-nomatch');
  const nomatchQuery = document.getElementById('bb-nomatch-query');
  const nomatchAdd   = document.getElementById('bb-nomatch-add');
  const showHiddenBtn = document.getElementById('bb-showhidden-toggle');
  const hiddenCountEl = document.getElementById('bb-hidden-count');
  const newBlockForm  = document.getElementById('bb-newblock-form');
  const newBlockInput = document.getElementById('bb-newblock-input');
  const newBlockCat   = document.getElementById('bb-newblock-category');
  const tallyEl       = document.getElementById('bb-tally');
  const tallyCountEl  = document.getElementById('bb-tally-count');
  const tallyNounEl   = document.getElementById('bb-tally-noun');

  // Which category chip is active ('all' or a category slug).
  let activeCat = 'all';

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Bust / un-bust a block ──────────────────────────────────────────────
  function updateTally(delta) {
    let n = (parseInt(tallyCountEl.textContent, 10) || 0) + delta;
    if (n < 0) n = 0;
    tallyCountEl.textContent = n;
    tallyNounEl.textContent = n === 1 ? 'block' : 'blocks';
    tallyEl.hidden = n === 0;
  }
  // Reflection step (step 2): show the chosen way through + a field, hide the
  // options list. Reset returns to the options list.
  function openReflect(block, optionText) {
    const chosen = block.querySelector('.bb-reflect-chosen-text');
    if (chosen) chosen.textContent = optionText;
    block.querySelector('.bb-options-wrap').hidden = true;
    const reflect = block.querySelector('.bb-reflect');
    reflect.hidden = false;
    const input = reflect.querySelector('.bb-reflect-input');
    if (input) { input.value = ''; input.focus(); }
  }
  function resetReflect(block) {
    const reflect = block.querySelector('.bb-reflect');
    if (reflect) reflect.hidden = true;
    const wrap = block.querySelector('.bb-options-wrap');
    if (wrap) wrap.hidden = false;
  }
  function applyBusted(block) {
    block.classList.add('bb-block--busted');
    resetReflect(block); // leave a clean options view for if they un-bust
  }
  function clearBusted(block) {
    block.classList.remove('bb-block--busted');
    resetReflect(block);
  }

  // Confetti-ish burst of block-colored shards from a point (viewport coords).
  function burst(cx, cy, color) {
    const count = 26;
    for (let i = 0; i < count; i++) {
      const shard = document.createElement('div');
      shard.className = 'bb-shard';
      const sz = 7 + Math.random() * 11;
      shard.style.width = sz + 'px';
      shard.style.height = (sz * (0.7 + Math.random() * 0.6)) + 'px';
      shard.style.left = cx + 'px';
      shard.style.top = cy + 'px';
      shard.style.background = Math.random() < 0.28 ? '#ffffff' : color;
      document.body.appendChild(shard);
      const angle = Math.random() * Math.PI * 2;
      const dist = 55 + Math.random() * 150;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - (35 + Math.random() * 55);
      const gravity = 110 + Math.random() * 130;
      const rot = Math.random() * 720 - 360;
      const dur = 650 + Math.random() * 450;
      const anim = shard.animate([
        { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { offset: 0.7, opacity: 1 },
        { transform: `translate(-50%,-50%) translate(${dx}px, ${dy + gravity}px) rotate(${rot}deg)`, opacity: 0 },
      ], { duration: dur, easing: 'cubic-bezier(0.15, 0.6, 0.35, 1)' });
      anim.onfinish = () => shard.remove();
    }
  }

  async function bustBlock(block, optionText, reflection) {
    if (block.classList.contains('bb-block--busted')) return;
    const catColor = getComputedStyle(block).getPropertyValue('--cat').trim() || '#705C6C';
    const collapseDelay = reduceMotion() ? 0 : 700;

    if (!reduceMotion()) {
      const r = block.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, catColor);
      block.classList.add('bb-block--bursting');
      setTimeout(() => block.classList.remove('bb-block--bursting'), 520);
    }
    applyBusted(block);
    updateTally(+1);
    // collapse after the burst so it reads as "busted, done"
    setTimeout(() => {
      block.querySelector('.bb-block-trigger').setAttribute('aria-expanded', 'false');
      block.querySelector('.bb-block-body').hidden = true;
    }, collapseDelay);

    try {
      await post('/api/block-buster/bust', {
        blockKey: block.dataset.key,
        optionText: optionText || '',
        reflection: reflection || '',
      });
    } catch (err) {
      clearBusted(block);
      updateTally(-1);
      alert("Couldn't save that just now. Please try again.");
    }
  }

  // ── Visibility helpers ──────────────────────────────────────────────────
  function showingHidden() { return categoriesEl.classList.contains('bb-show-hidden'); }
  function blockVisible(block) {
    if (block.classList.contains('bb-search-hidden')) return false;
    if (block.classList.contains('bb-block--hidden') && !showingHidden()) return false;
    return true;
  }
  function refreshCategories() {
    let anyVisibleAll = false;
    categoriesEl.querySelectorAll('.bb-category').forEach(cat => {
      const inFilter = activeCat === 'all' || cat.dataset.cat === activeCat;
      const any = inFilter && [...cat.querySelectorAll('.bb-block')].some(blockVisible);
      // Filtered-out categories collapse via a class; empty ones via display.
      cat.classList.toggle('bb-cat-filtered', !inFilter);
      cat.style.display = any ? '' : 'none';
      if (any) anyVisibleAll = true;
    });
    return anyVisibleAll;
  }

  // Count of non-hidden blocks per category, mirrored onto its chooser chip.
  function updateCatCounts() {
    categoriesEl.querySelectorAll('.bb-category').forEach(cat => {
      const n = [...cat.querySelectorAll('.bb-block')]
        .filter(b => !b.classList.contains('bb-block--hidden')).length;
      const badge = chooserEl.querySelector('[data-cat-count="' + cat.dataset.cat + '"]');
      if (badge) badge.textContent = n;
    });
  }

  // Move the active state to a chooser chip (by slug) without re-filtering.
  function markActiveChip(slug) {
    chooserEl.querySelectorAll('.bb-chooser-card').forEach(card => {
      const on = card.dataset.cat === slug;
      card.classList.toggle('bb-chooser-card--active', on);
      card.setAttribute('aria-pressed', String(on));
    });
  }
  function updateHiddenCount() {
    updateCatCounts();
    const n = categoriesEl.querySelectorAll('.bb-block--hidden').length;
    hiddenCountEl.textContent = n;
    showHiddenBtn.hidden = n === 0;
    if (n === 0 && showingHidden()) {
      categoriesEl.classList.remove('bb-show-hidden');
      showHiddenBtn.setAttribute('aria-pressed', 'false');
      showHiddenBtn.firstChild && (showHiddenBtn.childNodes[0].textContent = 'Show hidden blocks (');
    }
  }

  // ── Accordion open/close + all click actions ────────────────────────────
  categoriesEl.addEventListener('click', async function (e) {
    // Step 1 — "Try this" on a way through → open the reflection step
    const tryBtn = e.target.closest('.bb-try');
    if (tryBtn) {
      const block = tryBtn.closest('.bb-block');
      const opt = tryBtn.closest('.bb-option').querySelector('.bb-option-text');
      openReflect(block, opt ? opt.textContent.trim() : '');
      return;
    }

    // Back out of the reflection step → return to the ways through
    const backBtn = e.target.closest('.bb-reflect-back');
    if (backBtn) {
      resetReflect(backBtn.closest('.bb-block'));
      return;
    }

    // Step 2 — "Complete" → save the reflection and bust the block
    const completeBtn = e.target.closest('.bb-reflect-complete');
    if (completeBtn) {
      const block = completeBtn.closest('.bb-block');
      const reflect = block.querySelector('.bb-reflect');
      const optionText = reflect.querySelector('.bb-reflect-chosen-text').textContent.trim();
      const reflection = reflect.querySelector('.bb-reflect-input').value.trim();
      bustBlock(block, optionText, reflection);
      return;
    }

    // Bring a busted block back
    const unbustBtn = e.target.closest('.bb-unbust-btn');
    if (unbustBtn) {
      const block = unbustBtn.closest('.bb-block');
      unbustBtn.disabled = true;
      try {
        await post('/api/block-buster/unbust', { blockKey: block.dataset.key });
        clearBusted(block);
        updateTally(-1);
      } catch (err) { alert("Couldn't bring it back. Please try again."); }
      finally { unbustBtn.disabled = false; }
      return;
    }

    // Toggle a block open/closed
    const trigger = e.target.closest('.bb-block-trigger');
    if (trigger) {
      const body = trigger.nextElementSibling;
      const open = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      return;
    }

    // Remove a personal option
    const rm = e.target.closest('.bb-delete-option');
    if (rm) {
      const li = rm.closest('.bb-option');
      rm.disabled = true;
      try { await post('/api/block-buster/option/' + li.dataset.optionId + '/delete', {}); li.remove(); }
      catch (err) { rm.disabled = false; alert("Couldn't remove that. Please try again."); }
      return;
    }

    // Hide a built-in block
    const hideBtn = e.target.closest('.bb-hide-block');
    if (hideBtn) {
      const block = hideBtn.closest('.bb-block');
      hideBtn.disabled = true;
      try {
        await post('/api/block-buster/hide', { blockKey: block.dataset.key, hidden: true });
        block.classList.add('bb-block--hidden');
        block.querySelector('.bb-block-trigger').setAttribute('aria-expanded', 'false');
        block.querySelector('.bb-block-body').hidden = true;
        swapManage(block, 'unhide');
        updateHiddenCount();
        refreshCategories();
      } catch (err) { hideBtn.disabled = false; alert("Couldn't hide that. Please try again."); }
      return;
    }

    // Unhide a built-in block
    const unhideBtn = e.target.closest('.bb-unhide-block');
    if (unhideBtn) {
      const block = unhideBtn.closest('.bb-block');
      unhideBtn.disabled = true;
      try {
        await post('/api/block-buster/hide', { blockKey: block.dataset.key, hidden: false });
        block.classList.remove('bb-block--hidden');
        swapManage(block, 'hide');
        updateHiddenCount();
        refreshCategories();
      } catch (err) { unhideBtn.disabled = false; alert("Couldn't unhide that. Please try again."); }
      return;
    }

    // Delete a custom block
    const delBtn = e.target.closest('.bb-delete-block');
    if (delBtn) {
      const block = delBtn.closest('.bb-block');
      if (!confirm('Delete this block and everything you added to it?')) return;
      delBtn.disabled = true;
      try { await post('/api/block-buster/block/' + block.dataset.blockId + '/delete', {}); block.remove(); updateCatCounts(); refreshCategories(); }
      catch (err) { delBtn.disabled = false; alert("Couldn't delete that. Please try again."); }
      return;
    }
  });

  function swapManage(block, mode) {
    const wrap = block.querySelector('.bb-block-manage');
    if (mode === 'unhide') {
      wrap.innerHTML = '<button type="button" class="bb-icon-btn bb-unhide-block">Unhide this block</button>';
    } else {
      wrap.innerHTML = '<button type="button" class="bb-icon-btn bb-hide-block">Hide this block</button>';
    }
  }

  // ── Add a personal option (form submit inside a block) ──────────────────
  categoriesEl.addEventListener('submit', async function (e) {
    const form = e.target.closest('.bb-add-option');
    if (!form) return;
    e.preventDefault();
    const block = form.closest('.bb-block');
    const input = form.querySelector('.bb-add-option-input');
    const btn   = form.querySelector('.bb-add-option-btn');
    const text  = input.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      const data = await post('/api/block-buster/option', { blockKey: block.dataset.key, text });
      const li = document.createElement('li');
      li.className = 'bb-option bb-option--mine';
      li.dataset.optionId = data.id;
      li.innerHTML =
        '<span class="bb-option-text">' + esc(text) + '</span>' +
        '<button type="button" class="bb-try">Try this</button>' +
        '<button type="button" class="bb-option-remove bb-delete-option" title="Remove this" aria-label="Remove this">×</button>';
      block.querySelector('.bb-options').appendChild(li);
      input.value = '';
      input.focus();
    } catch (err) { alert("Couldn't save that just now. Please try again."); }
    finally { btn.disabled = false; }
  });

  // ── Category chooser (pick your block) ──────────────────────────────────
  chooserEl.addEventListener('click', function (e) {
    const card = e.target.closest('.bb-chooser-card');
    if (!card) return;
    activeCat = card.dataset.cat;
    markActiveChip(activeCat);
    // A category pick is a fresh filter — clear any active search.
    if (searchInput.value) { searchInput.value = ''; }
    categoriesEl.querySelectorAll('.bb-block').forEach(b => b.classList.remove('bb-search-hidden'));
    nomatch.hidden = true;
    refreshCategories();
    // Scroll the chosen category into view (but not on "all" / when nothing shows).
    if (activeCat !== 'all') {
      const section = categoriesEl.querySelector('.bb-category[data-cat="' + activeCat + '"]');
      if (section && section.style.display !== 'none') {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });

  // ── Search ──────────────────────────────────────────────────────────────
  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    // Searching spans every category, so it resets the chooser to "all".
    if (q && activeCat !== 'all') { activeCat = 'all'; markActiveChip('all'); }
    categoriesEl.querySelectorAll('.bb-block').forEach(block => {
      const match = !q || block.dataset.title.indexOf(q) !== -1;
      block.classList.toggle('bb-search-hidden', !match);
    });
    const anyVisible = refreshCategories();
    if (q && !anyVisible) {
      nomatchQuery.textContent = searchInput.value.trim();
      nomatch.hidden = false;
    } else {
      nomatch.hidden = true;
    }
  }
  searchInput.addEventListener('input', runSearch);

  // No-match → prefill the add-block form with the query
  nomatchAdd.addEventListener('click', function () {
    newBlockInput.value = searchInput.value.trim();
    newBlockForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    newBlockCat.focus();
  });

  // ── Show / hide hidden blocks ───────────────────────────────────────────
  showHiddenBtn.addEventListener('click', function () {
    const on = categoriesEl.classList.toggle('bb-show-hidden');
    showHiddenBtn.setAttribute('aria-pressed', String(on));
    showHiddenBtn.childNodes[0].textContent = (on ? 'Hide hidden blocks (' : 'Show hidden blocks (');
    refreshCategories();
  });

  // ── Add your own block (into a category) ────────────────────────────────
  newBlockForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const title = newBlockInput.value.trim();
    const category = newBlockCat.value;
    const btn = newBlockForm.querySelector('.bb-newblock-btn');
    if (!title) { newBlockInput.focus(); return; }
    if (!category) { alert('Choose a category for your block.'); newBlockCat.focus(); return; }
    btn.disabled = true;
    try {
      const data = await post('/api/block-buster/block', { title, category });
      const holder = categoriesEl.querySelector('.bb-category[data-cat="' + category + '"] .bb-category-blocks');
      const div = document.createElement('div');
      div.className = 'bb-block';
      div.dataset.key = data.key;
      div.dataset.custom = 'true';
      div.dataset.blockId = data.id;
      div.dataset.title = title.toLowerCase();
      div.innerHTML =
        '<button type="button" class="bb-block-trigger" aria-expanded="true">' +
          '<span class="bb-block-title">' + esc(title) + ' <span class="bb-yours-tag">yours</span></span>' +
          '<span class="bb-busted-badge" aria-hidden="true">💥 Busted</span>' +
          '<span class="bb-block-chevron" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>' +
          '</span>' +
        '</button>' +
        '<div class="bb-block-body">' +
          '<div class="bb-busted-banner">' +
            '<span class="bb-busted-banner-text">💥 You busted this block.</span>' +
            '<a href="/block-buster/breakthroughs" class="bb-busted-link">See it in your Breakthroughs →</a>' +
            '<button type="button" class="bb-unbust-btn">Bring it back</button>' +
          '</div>' +
          '<div class="bb-tryflow">' +
            '<div class="bb-options-wrap">' +
              '<p class="bb-then-label">Ways through <span class="bb-then-hint">— pick one to try</span></p>' +
              '<ul class="bb-options"></ul>' +
              '<form class="bb-add-option">' +
                '<input type="text" class="bb-add-option-input" placeholder="Add your own way through…" maxlength="300" autocomplete="off">' +
                '<button type="submit" class="bb-add-option-btn">Add</button>' +
              '</form>' +
            '</div>' +
            '<div class="bb-reflect" hidden>' +
              '<button type="button" class="bb-reflect-back">← Back to ways through</button>' +
              '<p class="bb-reflect-chosen">You\'re trying: <span class="bb-reflect-chosen-text"></span></p>' +
              '<label class="bb-reflect-label">How did it go? <span class="bb-reflect-optional">optional, but worth writing</span></label>' +
              '<textarea class="bb-reflect-input" rows="4" maxlength="2000" placeholder="Write about how this way through worked for you…"></textarea>' +
              '<button type="button" class="bb-reflect-complete">Complete — bust this block 💥</button>' +
            '</div>' +
          '</div>' +
          '<div class="bb-block-manage"><button type="button" class="bb-icon-btn bb-delete-block">Delete this block</button></div>' +
        '</div>';
      holder.appendChild(div);
      newBlockInput.value = '';
      newBlockCat.selectedIndex = 0;
      // clear any search AND focus the filter on this block's category so the
      // new block is guaranteed visible, then reveal it.
      searchInput.value = '';
      categoriesEl.querySelectorAll('.bb-block').forEach(b => b.classList.remove('bb-search-hidden'));
      activeCat = category;
      markActiveChip(category);
      nomatch.hidden = true;
      updateCatCounts();
      refreshCategories();
      div.scrollIntoView({ behavior: 'smooth', block: 'center' });
      div.querySelector('.bb-add-option-input').focus();
    } catch (err) { alert("Couldn't add that block. Please try again."); }
    finally { btn.disabled = false; }
  });

  // Initial pass so any server-hidden blocks collapse their now-empty categories.
  updateCatCounts();
  refreshCategories();
})();
