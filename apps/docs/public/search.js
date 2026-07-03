/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Lightweight client search for the docs. Vanilla, no framework, deferred and non-blocking. Lazily
// fetches the prebuilt index (/search-index.json) on first use and filters on title, summary, slug,
// and the page's full body text (pre-stripped to plain text at build; matched, never displayed).
// Progressive enhancement: with JS off the input is simply inert and the sidebar handles navigation.
(() => {
  const input = document.getElementById('site-search-input');
  const results = document.getElementById('site-search-results');
  if (!input || !results) return;

  let index = null;
  let items = [];
  let active = -1;

  const load = async () => {
    if (index) return;
    try {
      const res = await fetch('/search-index.json');
      index = await res.json();
    } catch {
      index = [];
    }
  };

  const hide = () => {
    results.hidden = true;
    results.innerHTML = '';
    items = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const render = (matches) => {
    if (matches.length === 0) {
      hide();
      return;
    }
    results.innerHTML = matches
      .map(
        (m, i) =>
          `<a class="search-hit" role="option" id="search-hit-${i}" href="/${m.slug}/">` +
          `<span class="hit-section">${escapeHtml(m.section)}</span>` +
          `<span class="hit-title">${escapeHtml(m.title)}</span>` +
          `<span class="hit-summary">${escapeHtml(m.summary)}</span></a>`,
      )
      .join('');
    items = Array.from(results.children);
    active = -1;
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const search = async () => {
    await load();
    const q = input.value.trim().toLowerCase();
    if (!q) {
      hide();
      return;
    }
    const matches = (index || [])
      .filter(
        (d) =>
          `${d.title} ${d.summary} ${d.slug}`.toLowerCase().includes(q) ||
          (d.body || '').includes(q),
      )
      .slice(0, 8);
    render(matches);
  };

  const setActive = (n) => {
    if (items.length === 0) return;
    if (active >= 0) items[active].classList.remove('is-active');
    active = (n + items.length) % items.length;
    items[active].classList.add('is-active');
    input.setAttribute('aria-activedescendant', items[active].id);
  };

  input.addEventListener('focus', load);
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'Enter') {
      const target = active >= 0 ? items[active] : items[0];
      if (target) {
        e.preventDefault();
        window.location.href = target.getAttribute('href');
      }
    } else if (e.key === 'Escape') {
      input.value = '';
      hide();
      input.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target !== input && !results.contains(e.target)) hide();
  });

  // "/" focuses search from anywhere (unless already typing in a field).
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      input.focus();
    }
  });
})();
