/* The Creative Block Buster — add/remove personal options, add/delete own
   blocks, hide/unhide blocks. Event delegation so dynamically-added elements
   work without re-binding; every save reverts its optimistic UI on failure. */
(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error('request failed');
    return res.json();
  }

  const blocksWrap = document.getElementById('bb-blocks');

  // ── Add a personal option to a block ────────────────────────────────────
  blocksWrap.addEventListener('submit', async function (e) {
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
        '</span><button type="button" class="bb-option-remove bb-delete-option" title="Remove this option" aria-label="Remove this option">×</button>';
      block.querySelector('.bb-options').appendChild(li);
      input.value = '';
      input.focus();
    } catch (err) {
      alert("Couldn't save that just now. Please try again.");
    } finally {
      btn.disabled = false;
    }
  });

  // ── Click actions inside the blocks area (delete option, hide, delete block)
  blocksWrap.addEventListener('click', async function (e) {
    // Remove a personal option
    const rm = e.target.closest('.bb-delete-option');
    if (rm) {
      const li = rm.closest('.bb-option');
      const id = li.dataset.optionId;
      rm.disabled = true;
      try {
        await post('/api/block-buster/option/' + id + '/delete', {});
        li.remove();
      } catch (err) { rm.disabled = false; alert("Couldn't remove that. Please try again."); }
      return;
    }

    // Hide a built-in block → move it into the hidden list
    const hideBtn = e.target.closest('.bb-hide-block');
    if (hideBtn) {
      const block = hideBtn.closest('.bb-block');
      hideBtn.disabled = true;
      try {
        await post('/api/block-buster/hide', { blockKey: block.dataset.key, hidden: true });
        addToHiddenList(block.dataset.key, block.querySelector('.bb-block-title').childNodes[0].textContent.trim());
        block.remove();
      } catch (err) { hideBtn.disabled = false; alert("Couldn't hide that. Please try again."); }
      return;
    }

    // Delete a custom block
    const delBtn = e.target.closest('.bb-delete-block');
    if (delBtn) {
      const block = delBtn.closest('.bb-block');
      if (!confirm('Delete this block and everything you added to it?')) return;
      delBtn.disabled = true;
      try {
        await post('/api/block-buster/block/' + block.dataset.blockId + '/delete', {});
        block.remove();
      } catch (err) { delBtn.disabled = false; alert("Couldn't delete that. Please try again."); }
      return;
    }
  });

  // ── Add your own block ──────────────────────────────────────────────────
  const newBlockForm = document.getElementById('bb-newblock-form');
  newBlockForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const input = document.getElementById('bb-newblock-input');
    const btn   = newBlockForm.querySelector('.bb-newblock-btn');
    const title = input.value.trim();
    if (!title) return;
    btn.disabled = true;
    try {
      const data = await post('/api/block-buster/block', { title });
      const section = document.createElement('section');
      section.className = 'bb-block';
      section.dataset.key = data.key;
      section.dataset.custom = 'true';
      section.dataset.blockId = data.id;
      section.innerHTML =
        '<div class="bb-block-head">' +
          '<h2 class="bb-block-title">' + esc(title) + '<span class="bb-yours-tag">yours</span></h2>' +
          '<div class="bb-block-actions"><button type="button" class="bb-icon-btn bb-delete-block" title="Delete this block">Delete</button></div>' +
        '</div>' +
        '<ul class="bb-options"></ul>' +
        '<form class="bb-add-option">' +
          '<input type="text" class="bb-add-option-input" placeholder="Add your own way through…" maxlength="300" autocomplete="off">' +
          '<button type="submit" class="bb-add-option-btn">Add</button>' +
        '</form>';
      blocksWrap.appendChild(section);
      input.value = '';
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      section.querySelector('.bb-add-option-input').focus();
    } catch (err) {
      alert("Couldn't add that block. Please try again.");
    } finally {
      btn.disabled = false;
    }
  });

  // ── Unhide from the hidden list ─────────────────────────────────────────
  const hiddenWrap  = document.getElementById('bb-hidden-wrap');
  const hiddenList  = document.getElementById('bb-hidden-list');
  const hiddenCount = document.getElementById('bb-hidden-count');

  hiddenList.addEventListener('click', async function (e) {
    const btn = e.target.closest('.bb-unhide-block');
    if (!btn) return;
    const item = btn.closest('.bb-hidden-item');
    btn.disabled = true;
    try {
      await post('/api/block-buster/hide', { blockKey: item.dataset.key, hidden: false });
      // Simplest reliable way to re-materialize the block with its options:
      // reload. Unhiding is rare, so the reload cost is fine.
      location.reload();
    } catch (err) { btn.disabled = false; alert("Couldn't unhide that. Please try again."); }
  });

  function addToHiddenList(key, title) {
    const li = document.createElement('li');
    li.className = 'bb-hidden-item';
    li.dataset.key = key;
    li.innerHTML = '<span class="bb-hidden-item-title">' + esc(title) +
      '</span><button type="button" class="bb-icon-btn bb-unhide-block">Unhide</button>';
    hiddenList.appendChild(li);
    hiddenCount.textContent = hiddenList.children.length;
    hiddenWrap.hidden = false;
  }
})();
