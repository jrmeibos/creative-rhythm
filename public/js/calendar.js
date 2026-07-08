/* Calendar page — tile expand/collapse, integration week toggle */

const tiles      = document.querySelectorAll('.cal-tile');
const drawer     = document.getElementById('cal-drawer');
const drawerTitle = document.getElementById('cal-drawer-title');
const drawerRange = document.getElementById('cal-drawer-range');
const drawerClose = document.getElementById('cal-drawer-close');
let activeWeek   = null;

function openPanel(weekStart) {
  activeWeek = weekStart;
  drawer.removeAttribute('hidden');

  document.querySelectorAll('.cal-panel').forEach(p => {
    p.hidden = p.dataset.week !== weekStart;
  });

  const tile = document.querySelector(`.cal-tile[data-week="${weekStart}"]`);
  drawerTitle.textContent = tile?.querySelector('.cal-tile-name')?.textContent || '';
  drawerRange.textContent = tile?.querySelector('.cal-tile-range')?.textContent || '';

  tiles.forEach(t => {
    const expanded = t.dataset.week === weekStart;
    t.classList.toggle('is-active', expanded);
    t.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  setTimeout(() => drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

function closeDrawer() {
  activeWeek = null;
  drawer.setAttribute('hidden', '');
  tiles.forEach(t => {
    t.classList.remove('is-active');
    t.setAttribute('aria-expanded', 'false');
  });
}

tiles.forEach(tile => {
  tile.addEventListener('click', () => {
    if (tile.dataset.week === activeWeek) {
      closeDrawer();
    } else {
      openPanel(tile.dataset.week);
    }
  });
});

drawerClose?.addEventListener('click', closeDrawer);

/* Auto-open panel from URL ?open= param */
const openParam = new URLSearchParams(location.search).get('open');
if (openParam) {
  openPanel(openParam);
  const url = new URL(location.href);
  url.searchParams.delete('open');
  history.replaceState(null, '', url.toString());
}

/* Day-grid backdating — tap a past day to log a cutting for that day.
   One backdating form per week panel; tapping a different day swaps the
   form's date context without losing typed content. Tapping the same day
   again or Cancel closes the form. */
document.querySelectorAll('.cal-day-grid-section').forEach(section => {
  const weekStart  = section.dataset.week;
  const form       = section.querySelector('.cal-backdate-form');
  const dateSpan   = section.querySelector('.cal-backdate-form-date');
  const textareas  = form.querySelectorAll('.cal-backdate-textarea');
  const saveBtn    = form.querySelector('.cal-backdate-save');
  const cancelBtn  = form.querySelector('.cal-backdate-cancel');
  const savedMsg   = form.querySelector('.cal-backdate-saved');
  let activeDate = null;

  const fmtDate = iso => {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  };

  const closeForm = (clearText) => {
    form.classList.add('is-hidden');
    if (savedMsg) savedMsg.hidden = true;
    saveBtn.disabled = false;
    if (clearText) textareas.forEach(t => { t.value = ''; });
    section.querySelectorAll('.cal-day--past.is-active').forEach(b => b.classList.remove('is-active'));
    activeDate = null;
  };

  const openForm = (dateIso, btn) => {
    activeDate = dateIso;
    dateSpan.textContent = fmtDate(dateIso);
    form.classList.remove('is-hidden');
    section.querySelectorAll('.cal-day--past.is-active').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    if (savedMsg) savedMsg.hidden = true;
    saveBtn.disabled = false;
    // Focus the first textarea after the form is visible so keyboard users
    // land in the right place.
    setTimeout(() => textareas[0]?.focus(), 30);
  };

  section.querySelectorAll('.cal-day--past').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const dateIso = btn.dataset.date;
      if (activeDate === dateIso) {
        closeForm(false);   // tapping the same day toggles closed
      } else {
        openForm(dateIso, btn);
      }
    });
  });

  cancelBtn.addEventListener('click', () => closeForm(true));

  saveBtn.addEventListener('click', async () => {
    if (!activeDate) return;
    const payload = { recorded_date: activeDate };
    let anyFilled = false;
    textareas.forEach(t => {
      const v = t.value.trim();
      payload[t.dataset.cuttingKey] = v;
      if (v) anyFilled = true;
    });
    if (!anyFilled) { closeForm(true); return; }
    saveBtn.disabled = true;
    try {
      const res = await fetch('/dashboard/cutting', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('save failed');
      if (savedMsg) {
        savedMsg.hidden = false;
        setTimeout(() => closeForm(true), 1200);
      } else {
        closeForm(true);
      }
    } catch (e) {
      saveBtn.disabled = false;
      alert('Could not save. Please try again.');
    }
  });
});

/* Weekly reflection save — wired for all past-week panels */
document.querySelectorAll('.weekly-reflection').forEach(section => {
  const weekStart = section.dataset.week;
  const textarea  = section.querySelector('.weekly-reflection-textarea');
  const toggleCb  = section.querySelector('.cohort-toggle-cb');
  const saveBtn   = section.querySelector('.save-weekly-reflection');
  const savedMsg  = section.querySelector('.reflection-saved-msg');

  saveBtn?.addEventListener('click', async () => {
    const res = await fetch('/api/reflections', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        week_start:         weekStart,
        text:               textarea.value,
        shared_with_cohort: toggleCb.checked
      })
    });
    if (res.ok && savedMsg) {
      savedMsg.removeAttribute('hidden');
      setTimeout(() => savedMsg.setAttribute('hidden', ''), 2000);
    }
  });
});
