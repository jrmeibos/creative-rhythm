/* Dashboard goal card interactions — always-editable checklist */

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

async function saveGoalText(week, category, data) {
  await fetch('/api/goals/intention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekStart: week, category, goalText: JSON.stringify(data) })
  });
}

async function saveCompletion(week, category, completed) {
  await fetch('/api/goals/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekStart: week, category, completed })
  });
}

document.querySelectorAll('.goal-card').forEach(card => {
  const cardCheckbox = card.querySelector('.goal-card-checkbox');
  const alwaysEdit   = card.querySelector('.goal-checklist-always-edit');

  const week     = alwaysEdit?.dataset.week     || cardCheckbox?.dataset.week     || '';
  const category = alwaysEdit?.dataset.category || cardCheckbox?.dataset.category || '';

  /* ── Card-level completion ────────────────────────────────────────────────── */
  cardCheckbox?.addEventListener('change', async () => {
    card.classList.toggle('is-complete', cardCheckbox.checked);
    await saveCompletion(week, category, cardCheckbox.checked);
  });

  if (!alwaysEdit) return;

  const inputList = alwaysEdit.querySelector('.goal-checklist-input-list');

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

  function syncCompletionState() {
    const items   = collectItems();
    const allDone = items.length > 0 && items.every(it => it.checked);
    if (cardCheckbox) {
      cardCheckbox.checked = allDone;
      card.classList.toggle('is-complete', allDone);
    }
    saveCompletion(week, category, allDone);
  }

  const debouncedSave = debounce(async () => {
    await saveGoalText(week, category, { mode: 'checklist', items: collectItems() });
  }, 600);

  /* ── Event delegation ────────────────────────────────────────────────────── */
  alwaysEdit.addEventListener('input', e => {
    if (e.target.classList.contains('goal-checklist-edit-input')) debouncedSave();
  });

  alwaysEdit.addEventListener('change', e => {
    const cb = e.target.closest('.goal-item-cb');
    if (!cb) return;
    cb.closest('.goal-checklist-edit-row')?.classList.toggle('is-checked', cb.checked);
    syncCompletionState();
    debouncedSave();
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

  /* ── Reflection ──────────────────────────────────────────────────────────── */
  const reflPreview  = card.querySelector('.goal-card-reflection-preview');
  const reflPencil   = card.querySelector('.goal-card-reflection-pencil');
  const reflTextarea = card.querySelector('.goal-card-reflection-textarea');

  if (reflPreview && reflTextarea) {
    const openRefl = () => {
      reflPreview.hidden = true;
      reflTextarea.removeAttribute('hidden');
      reflTextarea.focus();
      reflTextarea.setSelectionRange(reflTextarea.value.length, reflTextarea.value.length);
    };

    reflPreview.addEventListener('click', openRefl);
    reflPencil?.addEventListener('click', e => { e.stopPropagation(); openRefl(); });
    reflPreview.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRefl(); }
    });

    const saveRefl = async () => {
      const text = reflTextarea.value.trim();
      await fetch('/api/goals/reflection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekStart:  reflTextarea.dataset.week,
          category:   reflTextarea.dataset.category,
          reflection: text
        })
      });
      reflTextarea.setAttribute('hidden', '');
      reflPreview.removeAttribute('hidden');
      const tEl = reflPreview.querySelector('.goal-card-reflection-text');
      const pEl = reflPreview.querySelector('.goal-card-reflection-prompt');
      if (text) {
        if (tEl) { tEl.textContent = text; tEl.removeAttribute('hidden'); }
        if (pEl) pEl.setAttribute('hidden', '');
      } else {
        if (tEl) { tEl.textContent = ''; tEl.setAttribute('hidden', ''); }
        if (pEl) pEl.removeAttribute('hidden');
      }
    };

    reflTextarea.addEventListener('blur', saveRefl);
    reflTextarea.addEventListener('keydown', e => {
      if (e.key === 'Escape') reflTextarea.blur();
    });
  }
});
