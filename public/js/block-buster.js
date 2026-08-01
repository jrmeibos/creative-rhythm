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
  const searchInput  = document.getElementById('bb-search-input');
  const nomatch      = document.getElementById('bb-nomatch');
  const nomatchQuery = document.getElementById('bb-nomatch-query');
  const nomatchAdd   = document.getElementById('bb-nomatch-add');
  const showHiddenBtn = document.getElementById('bb-showhidden-toggle');
  const hiddenCountEl = document.getElementById('bb-hidden-count');
  const newBlockForm  = document.getElementById('bb-newblock-form');
  const newBlockInput = document.getElementById('bb-newblock-input');
  const newBlockCat   = document.getElementById('bb-newblock-category');

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
      const any = [...cat.querySelectorAll('.bb-block')].some(blockVisible);
      cat.style.display = any ? '' : 'none';
      if (any) anyVisibleAll = true;
    });
    return anyVisibleAll;
  }
  function updateHiddenCount() {
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
      try { await post('/api/block-buster/block/' + block.dataset.blockId + '/delete', {}); block.remove(); refreshCategories(); }
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
      li.innerHTML = '<span class="bb-option-text">' + esc(text) +
        '</span><button type="button" class="bb-option-remove bb-delete-option" title="Remove this" aria-label="Remove this">×</button>';
      block.querySelector('.bb-options').appendChild(li);
      input.value = '';
      input.focus();
    } catch (err) { alert("Couldn't save that just now. Please try again."); }
    finally { btn.disabled = false; }
  });

  // ── Search ──────────────────────────────────────────────────────────────
  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
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
          '<span class="bb-block-chevron" aria-hidden="true">▸</span>' +
        '</button>' +
        '<div class="bb-block-body">' +
          '<p class="bb-then-label">Try one of these →</p>' +
          '<ul class="bb-options"></ul>' +
          '<form class="bb-add-option">' +
            '<input type="text" class="bb-add-option-input" placeholder="Add your own way through…" maxlength="300" autocomplete="off">' +
            '<button type="submit" class="bb-add-option-btn">Add</button>' +
          '</form>' +
          '<div class="bb-block-manage"><button type="button" class="bb-icon-btn bb-delete-block">Delete this block</button></div>' +
        '</div>';
      holder.appendChild(div);
      newBlockInput.value = '';
      newBlockCat.selectedIndex = 0;
      // clear any active search so the new block is visible, then reveal it
      searchInput.value = '';
      runSearch();
      div.scrollIntoView({ behavior: 'smooth', block: 'center' });
      div.querySelector('.bb-add-option-input').focus();
    } catch (err) { alert("Couldn't add that block. Please try again."); }
    finally { btn.disabled = false; }
  });

  // Initial pass so any server-hidden blocks collapse their now-empty categories.
  refreshCategories();
})();
