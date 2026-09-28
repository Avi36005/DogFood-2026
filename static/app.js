// Progressive enhancement only. Every page works without this file.
document.documentElement.classList.add('js');

document.addEventListener('DOMContentLoaded', () => {
  // Mobile navigation drawer.
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.toggleAttribute('data-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && nav.hasAttribute('data-open')) {
        nav.removeAttribute('data-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  // Copy buttons for one-time links.
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const field = document.getElementById(button.getAttribute('data-copy'));
      if (!field) return;
      field.select();
      try {
        await navigator.clipboard.writeText(field.value);
      } catch {
        document.execCommand('copy');
      }
      const label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = label; }, 1500);
    });
  }

  // Local time as a tooltip on every UTC timestamp.
  for (const time of document.querySelectorAll('time[datetime]')) {
    const date = new Date(time.getAttribute('datetime'));
    if (!Number.isNaN(date.getTime())) time.title = `Your time: ${date.toLocaleString()}`;
  }

  // Live regions: re-fetch a server-rendered fragment on an interval while the tab is visible.
  for (const region of document.querySelectorAll('[data-live]')) {
    const url = region.getAttribute('data-live');
    const seconds = Math.max(5, Number(region.getAttribute('data-interval')) || 10);
    let timer = null;
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch(url, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
        if (!response.ok) {
          clearInterval(timer);
          return;
        }
        region.innerHTML = await response.text();
      } catch {
        // Offline for a moment: keep the last good view and try again next tick.
      }
    };
    timer = setInterval(refresh, seconds * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
});
