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

/* Integration toggle inside panels */
document.querySelectorAll('.cal-integration-btn').forEach(btn => {
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    const week     = btn.dataset.week;
    const isActive = btn.dataset.active === 'true';
    const res = await fetch('/api/goals/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekStart: week, isIntegration: !isActive })
    });
    if (res.ok) {
      const url = new URL(location.href);
      url.searchParams.set('open', week);
      location.href = url.toString();
    }
  });
});

/* Integration week reflection textarea auto-save */
function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

document.querySelectorAll('.cal-integration-textarea').forEach(textarea => {
  const save = debounce(async () => {
    await fetch('/api/goals/reflection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        weekStart:  textarea.dataset.week,
        category:   'curiosity',
        reflection: textarea.value
      })
    });
  }, 800);
  textarea.addEventListener('input', save);
});

/* Auto-open panel from URL ?open= param (after integration toggle reload) */
const openParam = new URLSearchParams(location.search).get('open');
if (openParam) {
  openPanel(openParam);
  const url = new URL(location.href);
  url.searchParams.delete('open');
  history.replaceState(null, '', url.toString());
}
