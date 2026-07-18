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
// fetches the prebuilt index (/search-index.json) on first use and ranks on title, code tokens
// (reason codes and fault codes, matched verbatim), summary, slug, and the page's full body text
// (pre-stripped to lowercase plain text at build; matched, never displayed). Title matches outrank
// body matches, and among close scores operation pages surface first.
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

  // Where the query matched decides the rank: a title hit beats a code-token hit beats summary,
  // slug, then body. Codes compare uppercased so a typed insufficient_funds still lands the
  // verbatim INSUFFICIENT_FUNDS. The small Operations bump only reorders pages whose best match
  // is the same kind — it never lifts a body-only hit over a title hit elsewhere.
  const score = (d, q) => {
    const upper = q.toUpperCase();
    const title = d.title.toLowerCase();
    let s = 0;
    if (title === q) s = 200;
    else if (title.startsWith(q)) s = 120;
    else if (title.includes(q)) s = 100;
    else if ((d.code || []).some((c) => c === upper || c.endsWith(`.${upper}`))) s = 90;
    else if ((d.code || []).some((c) => c.includes(upper))) s = 60;
    else if (d.summary.toLowerCase().includes(q)) s = 40;
    else if (d.slug.includes(q)) s = 30;
    else if ((d.body || '').includes(q)) s = 10;
    if (s > 0 && d.section === 'Operations') s += 5;
    return s;
  };

  const search = async () => {
    await load();
    const q = input.value.trim().toLowerCase();
    if (!q) {
      hide();
      return;
    }
    const matches = (index || [])
      .map((d, i) => ({ d, s: score(d, q), i }))
      .filter((m) => m.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, 8)
      .map((m) => m.d);
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
