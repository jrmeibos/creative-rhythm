/* Goals page — always-editable checklist intentions, reflections, integration week toggle */

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

async function post(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.ok;
}

function showSaved(category) {
  const el = document.getElementById(`save-status-${category}`);
  if (!el) return;
  el.textContent = 'Saved ✓';
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}

/* ── Per-card intention logic ─────────────────────────────────────────────── */

document.querySelectorAll('.goal-full-card').forEach(card => {
  const alwaysEdit = card.querySelector('.goal-checklist-always-edit');
  const headerCb   = card.querySelector('.header-complete-checkbox');

  if (!alwaysEdit) return;

  const inputList = alwaysEdit.querySelector('.goal-checklist-input-list');
  const week      = alwaysEdit.dataset.week     || '';
  const category  = alwaysEdit.dataset.category || '';

  function createEditRow(text = '', checked = false) {
    const li = document.createElement('li');
    li.className = 'goal-checklist-edit-row' + (checked ? ' is-checked' : '');
    const label = document.createElement('label');
    label.className = 'goal-checklist-check-wrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'goal-checklist-checkbox goal-item-cb';
    cb.checked = checked;
    const visual = document.createElement('span');
    visual.className = 'goal-checklist-check-visual';
    label.append(cb, visual);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'goal-checklist-edit-input';
    input.placeholder = 'Add item...';
    input.value = text;
    li.append(label, input);
    return li;
  }

  function collectItems() {
    return Array.from(inputList.querySelectorAll('.goal-checklist-edit-row')).map(row => ({
      text:    row.querySelector('.goal-checklist-edit-input')?.value.trim() || '',
      checked: row.querySelector('.goal-item-cb')?.checked || false
    })).filter(item => item.text);
  }

  const debouncedSave = debounce(async () => {
    const items = collectItems();
    const ok = await post('/api/goals/intention', {
      weekStart: week,
      category,
      goalText: JSON.stringify({ mode: 'checklist', items })
    });
    if (ok) showSaved(category);
  }, 600);

  /* ── Event delegation ────────────────────────────────────────────────────── */
  alwaysEdit.addEventListener('input', e => {
    if (e.target.classList.contains('goal-checklist-edit-input')) debouncedSave();
  });

  alwaysEdit.addEventListener('change', e => {
    const cb = e.target.closest('.goal-item-cb');
    if (!cb) return;
    cb.closest('.goal-checklist-edit-row')?.classList.toggle('is-checked', cb.checked);
    debouncedSave();
    const items   = collectItems();
    const allDone = items.length > 0 && items.every(it => it.checked);
    if (headerCb) {
      headerCb.checked = allDone;
      post('/api/goals/complete', { weekStart: week, category, completed: allDone });
    }
  });

  alwaysEdit.addEventListener('keydown', e => {
    if (!e.target.classList.contains('goal-checklist-edit-input')) return;
    const row = e.target.closest('.goal-checklist-edit-row');
    if (!row) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const newRow = createEditRow();
      row.after(newRow);
      newRow.querySelector('.goal-checklist-edit-input').focus();
    } else if (e.key === 'Backspace' && e.target.value === '') {
      e.preventDefault();
      if (inputList.children.length <= 1) return;
      const prev = row.previousElementSibling;
      const next = row.nextElementSibling;
      row.remove();
      (prev ?? next)?.querySelector('.goal-checklist-edit-input')?.focus();
    }
  });
});

/* ── Reflection auto-save ─────────────────────────────────────────────────── */

document.querySelectorAll('.checkin-textarea').forEach(textarea => {
  const save = debounce(async () => {
    const ok = await post('/api/goals/reflection', {
      weekStart:  textarea.dataset.week,
      category:   textarea.dataset.category,
      reflection: textarea.value
    });
    if (ok) showSaved(textarea.dataset.category);
  }, 800);

  textarea.addEventListener('input', save);
});

/* ── Completion checkbox ──────────────────────────────────────────────────── */

document.querySelectorAll('.header-complete-checkbox').forEach(checkbox => {
  checkbox.addEventListener('change', async () => {
    const ok = await post('/api/goals/complete', {
      weekStart: checkbox.dataset.week,
      category:  checkbox.dataset.category,
      completed: checkbox.checked
    });
    if (ok) showSaved(checkbox.dataset.category);
  });
});

/* ── Integration week toggle ──────────────────────────────────────────────── */

const integrationBtn = document.getElementById('integration-toggle');
if (integrationBtn) {
  integrationBtn.addEventListener('click', async () => {
    const isActive = integrationBtn.dataset.active === 'true';
    const ok = await post('/api/goals/integration', {
      weekStart:     integrationBtn.dataset.week,
      isIntegration: !isActive
    });
    if (ok) location.reload();
  });
}
