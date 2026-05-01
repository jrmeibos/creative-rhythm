/* Community page — member card expand/collapse */

const cards      = document.querySelectorAll('.comm-card');
const drawer     = document.getElementById('comm-drawer');
const drawerName = document.getElementById('comm-drawer-name');
const drawerClose = document.getElementById('comm-drawer-close');
let activeUser   = null;

function openPanel(userId, name) {
  activeUser = userId;
  drawer.removeAttribute('hidden');
  drawerName.textContent = name;

  document.querySelectorAll('.comm-panel').forEach(p => {
    p.hidden = p.dataset.userId !== userId;
  });

  cards.forEach(c => {
    const active = c.dataset.userId === userId;
    c.classList.toggle('is-active', active);
    c.setAttribute('aria-expanded', active ? 'true' : 'false');
  });

  setTimeout(() => drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

function closeDrawer() {
  activeUser = null;
  drawer.setAttribute('hidden', '');
  cards.forEach(c => {
    c.classList.remove('is-active');
    c.setAttribute('aria-expanded', 'false');
  });
}

cards.forEach(card => {
  card.addEventListener('click', () => {
    if (card.dataset.userId === activeUser) {
      closeDrawer();
    } else {
      openPanel(card.dataset.userId, card.dataset.name);
    }
  });
});

drawerClose?.addEventListener('click', closeDrawer);
