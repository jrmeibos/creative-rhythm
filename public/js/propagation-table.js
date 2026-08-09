/* The Propagation Table — open menu of eight rungs. Expand a rung to read the
   guide, "Mark as made" to log progress (optimistic; reverts on error), with a
   little garden-confetti burst per rung and a bigger volley at 8 of 8. */
(function () {
  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error('request failed');
    return res.json();
  }

  const rungsEl  = document.getElementById('pt-rungs');
  const fillEl   = document.getElementById('pt-fill');
  const doneEl   = document.getElementById('pt-done');
  const totalEl  = document.getElementById('pt-total');
  const finishEl = document.getElementById('pt-finish');
  const total    = parseInt(totalEl.textContent, 10) || 8;

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const GARDEN = ['#F6C95C', '#76856C', '#D8B0AB', '#a990a4', '#705C6C'];

  function currentDone() { return rungsEl.querySelectorAll('.pt-rung--made').length; }

  function updateProgress(done) {
    doneEl.textContent = done;
    fillEl.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    const complete = done >= total;
    if (complete && finishEl.hidden) {
      finishEl.hidden = false;
      if (!reduceMotion()) {
        finishEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        bigBurst();
      }
    } else if (!complete && !finishEl.hidden) {
      finishEl.hidden = true;
    }
  }

  function burst(cx, cy, count) {
    for (let i = 0; i < count; i++) {
      const s = document.createElement('div');
      s.className = 'pt-shard';
      const sz = 6 + Math.random() * 10;
      s.style.width = sz + 'px';
      s.style.height = (sz * (0.7 + Math.random() * 0.6)) + 'px';
      s.style.left = cx + 'px';
      s.style.top = cy + 'px';
      s.style.background = GARDEN[Math.floor(Math.random() * GARDEN.length)];
      document.body.appendChild(s);
      const ang = Math.random() * Math.PI * 2;
      const dist = 50 + Math.random() * 140;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist - (30 + Math.random() * 50);
      const grav = 110 + Math.random() * 130;
      const rot = Math.random() * 720 - 360;
      const dur = 650 + Math.random() * 450;
      const a = s.animate([
        { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { offset: 0.7, opacity: 1 },
        { transform: `translate(-50%,-50%) translate(${dx}px, ${dy + grav}px) rotate(${rot}deg)`, opacity: 0 },
      ], { duration: dur, easing: 'cubic-bezier(0.15, 0.6, 0.35, 1)' });
      a.onfinish = () => s.remove();
    }
  }
  function rungBurst(rung) {
    if (reduceMotion()) return;
    const r = rung.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, 22);
    rung.classList.add('pt-rung--popping');
    setTimeout(() => rung.classList.remove('pt-rung--popping'), 520);
  }
  function bigBurst() {
    burst(window.innerWidth / 2, window.innerHeight * 0.4, 64);
  }

  rungsEl.addEventListener('click', async function (e) {
    // Mark / un-mark a rung
    const mark = e.target.closest('.pt-mark');
    if (mark) {
      const rung = mark.closest('.pt-rung');
      const slug = rung.dataset.slug;
      const wasMade = rung.classList.contains('pt-rung--made');
      mark.disabled = true;
      // optimistic UI
      if (wasMade) {
        rung.classList.remove('pt-rung--made');
      } else {
        rung.classList.add('pt-rung--made');
        rungBurst(rung);
      }
      updateProgress(currentDone());
      try {
        await post('/api/propagation-table/' + (wasMade ? 'unmark' : 'mark'), { slug });
      } catch (err) {
        rung.classList.toggle('pt-rung--made', wasMade); // revert
        updateProgress(currentDone());
        alert("Couldn't save that just now. Please try again.");
      } finally {
        mark.disabled = false;
      }
      return;
    }

    // Expand / collapse a rung
    const head = e.target.closest('.pt-rung-head');
    if (head) {
      const body = head.nextElementSibling;
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
    }
  });
})();
