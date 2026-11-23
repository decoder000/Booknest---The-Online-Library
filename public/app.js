/* ==========================================================================
   Booknest - client script
   ========================================================================== */
(() => {
  'use strict';

  const TOKEN_KEY = 'booknest_token';
  const THEME_KEY = 'booknest_theme';
  const MIN_COVER_WIDTH = 400;
  const PAGE_SIZE = 12;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    token: localStorage.getItem(TOKEN_KEY),
    theme: document.documentElement.dataset.theme || 'light',
    user: null,
    categories: [],
    categoryId: null,
    search: '',
    sort: 'newest',
    catalogBooks: [],
    catalogLimit: PAGE_SIZE,
    bookmarks: new Set(),
    pendingAction: null,
    catalogSeq: 0,
    catalogLoaded: false,
    currentBookId: null,
    currentBook: null,
    reader: null,
    libraryTab: 'downloads',
    adminTab: 'add',
    adminBooks: [],
  };

  /* ------------------------------ Utilities ------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const fmtNumber = (n) => Number(n || 0).toLocaleString();

  function parseSqlDate(ts) {
    if (!ts) return null;
    const d = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(ts, withTime = false) {
    const d = parseSqlDate(ts);
    if (!d) return '-';
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return withTime ? `${date} \u00b7 ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : date;
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const ICONS = {
    heart: '<path d="M19.5 12.6 12 20l-7.5-7.4A4.9 4.9 0 0 1 12 6.1a4.9 4.9 0 0 1 7.5 6.5z"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>',
    info: '<path d="M12 11v5M12 7.5v.01"/><circle cx="12" cy="12" r="9"/>',
    library: '<path d="M5 4h3v16H5zM10 4h3v16h-3zM15.2 4.6l2.9-.8 3.9 15.4-2.9.8z"/>',
    studio: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19.5A2 2 0 0 1 6 18h13"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    read: '<path d="M2 5.5c3.3-1.3 6.7-1.3 10 1 3.3-2.3 6.7-2.3 10-1V19c-3.3-1.3-6.7-1.3-10 1-3.3-2.3-6.7-2.3-10-1z"/><path d="M12 6.5V20"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  };

  const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  function starsHtml(avg, count, { compact = false } = {}) {
    const n = Number(count) || 0;
    if (!n) return `<span class="rating rating--empty">${compact ? 'No reviews' : 'No reviews yet'}</span>`;
    const value = Math.max(0, Math.min(5, Number(avg) || 0));
    const pct = (value / 5) * 100;
    return `<span class="rating">
      <span class="stars" style="--pct:${pct.toFixed(1)}%" role="img" aria-label="Rated ${value.toFixed(1)} out of 5">★★★★★</span>
      <span class="rating__value">${value.toFixed(1)}</span>
      <span class="rating__count">(${fmtNumber(n)})</span>
    </span>`;
  }

  const progressPct = (p) => (p && p.total_pages ? Math.round((Math.min(p.current_page, p.total_pages) / p.total_pages) * 100) : 0);
  const progressBadge = (p) => `<span class="badge-progress">Page ${fmtNumber(p.current_page)} of ${fmtNumber(p.total_pages)}</span>`;

  function coverHtml(book, alt = true) {
    const altText = alt ? `Cover of ${esc(book.title)}` : '';
    return `<div class="cover">${
      book.cover_path ? `<img src="${esc(book.cover_path)}" alt="${altText}" loading="lazy" decoding="async" />` : ''
    }</div>`;
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
  }

  /* ----------------------------- Theme Toggle ---------------------------- */

  function applyTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem(THEME_KEY, state.theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = state.theme === 'dark' ? '#090D16' : '#F8FAFC';
    renderNav();
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  /* ------------------------------- Toasts -------------------------------- */

  function toast(type, title, message = '') {
    const iconName = { success: 'check', error: 'alert', info: 'info' }[type] || 'info';
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<span class="toast__icon">${icon(iconName)}</span>
      <div><div class="toast__title">${esc(title)}</div>${message ? `<div class="toast__msg">${esc(message)}</div>` : ''}</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    }, 4200);
  }

  /* ------------------------------ API client ----------------------------- */

  async function api(path, { method = 'GET', body, formData } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let payload;
    if (formData) payload = formData;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, { method, headers, body: payload });
    } catch (networkErr) {
      throw new Error('Cannot reach the Booknest server. Is it running?');
    }

    let data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      data = null;
    }

    if (!res.ok) {
      if (res.status === 401 && state.token && !path.startsWith('/api/auth/login')) {
        clearSession();
      }
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ------------------------------- Session ------------------------------- */

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(TOKEN_KEY, token);
    renderNav();
    loadRequests();
    return loadBookmarks();
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    state.bookmarks.clear();
    localStorage.removeItem(TOKEN_KEY);
    renderNav();
    updateBookmarkUI();
    loadRequests();
  }

  async function restoreSession() {
    if (!state.token) return renderNav();
    try {
      const { user } = await api('/api/auth/me');
      state.user = user;
      renderNav();
      await loadBookmarks();
    } catch (err) {
      clearSession();
    }
  }

  async function loadBookmarks() {
    if (!state.user) return;
    try {
      const data = await api('/api/user/dashboard');
      state.bookmarks = new Set(data.bookmarks.map((b) => b.book_id));
      updateBookmarkUI();
    } catch (err) {
      // Non-critical
    }
  }

  function requireLogin(action, message) {
    if (state.user) return true;
    state.pendingAction = action;
    openAuth('login', message);
    return false;
  }

  /* -------------------------------- Navbar ------------------------------- */

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  }

  function renderNav() {
    const el = $('#navActions');
    const isDark = state.theme === 'dark';
    const themeBtn = `<button type="button" class="icon-btn" data-action="toggle-theme" aria-label="Switch to ${isDark ? 'light' : 'dark'} mode" title="Switch to ${isDark ? 'light' : 'dark'} mode">${icon(isDark ? 'sun' : 'moon')}</button>`;
    $('#beReaderBtn').hidden = Boolean(state.user);
    if (!state.user) {
      el.innerHTML = `
        ${themeBtn}
        <button type="button" class="btn btn--ghost" data-action="open-auth" data-tab="login">Sign in</button>
        <button type="button" class="btn btn--primary" data-action="open-auth" data-tab="register">Create account</button>`;
      return;
    }
    const u = state.user;
    el.innerHTML = `
      ${themeBtn}
      ${u.role === 'admin' ? `<button type="button" class="btn btn--ghost btn--label-hide" data-action="open-admin">${icon('studio')}<span>Admin Studio</span></button>` : ''}
      <button type="button" class="btn btn--soft btn--label-hide" data-action="open-library">${icon('library')}<span>My Library</span></button>
      <div class="user-chip">
        <span class="avatar" aria-hidden="true">${esc(initials(u.full_name))}</span>
        <span class="user-chip__meta">
          <span class="user-chip__name">${esc(u.full_name)}</span>
          <span class="user-chip__role">${esc(u.role === 'admin' ? 'Administrator' : 'Reader')}</span>
        </span>
        <button type="button" class="icon-btn" data-action="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button>
      </div>`;
  }

  /* -------------------------------- Stats -------------------------------- */

  function animateCount(el, target) {
    const start = Number(el.dataset.value || 0);
    el.dataset.value = target;
    if (reduceMotion || start === target) {
      el.textContent = fmtNumber(target);
      return;
    }
    const duration = 900;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtNumber(Math.round(start + (target - start) * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function loadStats() {
    try {
      const stats = await api('/api/stats');
      $$('[data-stat]').forEach((el) => animateCount(el, stats[el.dataset.stat]));
      $$('[data-stat-text]').forEach((el) => (el.textContent = fmtNumber(stats[el.dataset.statText])));
    } catch (err) {
      toast('error', 'Could not load statistics', err.message);
    }
  }

  /* ------------------------------ Categories ----------------------------- */

  async function loadCategories() {
    try {
      const { categories } = await api('/api/categories');
      state.categories = categories;
      if (state.categoryId && !categories.some((c) => c.category_id === state.categoryId)) state.categoryId = null;
      renderPills();
      renderAdminCategoryOptions();
    } catch (err) {
      toast('error', 'Could not load categories', err.message);
    }
  }

  function renderPills() {
    const total = state.categories.reduce((sum, c) => sum + c.book_count, 0);
    const pill = (id, label, count) => {
      const active = state.categoryId === id;
      return `<button type="button" class="pill ${active ? 'is-active' : ''}" role="tab" aria-selected="${active}"
        data-action="category" data-id="${id ?? ''}">${esc(label)}<span class="pill__count">${count}</span></button>`;
    };
    const row = $('#categoryPills');
    const scrollLeft = row.scrollLeft;
    row.innerHTML =
      pill(null, 'All books', total) + state.categories.map((c) => pill(c.category_id, c.category_name, c.book_count)).join('');
    row.scrollLeft = scrollLeft;
    const active = $('.pill.is-active', row);
    if (active) {
      const a = active.offsetLeft;
      const b = a + active.offsetWidth;
      if (a < row.scrollLeft) row.scrollTo({ left: a - 24, behavior: reduceMotion ? 'auto' : 'smooth' });
      else if (b > row.scrollLeft + row.clientWidth) row.scrollTo({ left: b - row.clientWidth + 24, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function renderAdminCategoryOptions() {
    const select = $('#adminCategory');
    const current = select.value;
    select.innerHTML =
      '<option value="">Uncategorized</option>' +
      state.categories.map((c) => `<option value="${c.category_id}">${esc(c.category_name)}</option>`).join('');
    if (current) select.value = current;
  }

  /* ------------------------------- Trending ------------------------------ */

  async function loadTrending() {
    const shelf = $('#trendingShelf');
    try {
      const { books } = await api('/api/books?sort=popular&limit=4');
      if (!books.length) {
        shelf.innerHTML = `<div class="empty"><h3>No books yet</h3><p>Trending titles appear once books are published.</p></div>`;
        return;
      }
      shelf.innerHTML = books
        .map(
          (b, i) => `
        <button type="button" class="trend-card" data-action="open-book" data-id="${b.book_id}" aria-label="#${i + 1}: ${esc(b.title)}">
          <div class="trend-card__cover">${coverHtml(b, false)}<span class="trend-card__rank">${i + 1}</span></div>
          <div>
            <div class="trend-card__title">${esc(b.title)}</div>
            <div class="trend-card__author">${esc(b.author)}</div>
            <div class="trend-card__rating">${starsHtml(b.avg_rating, b.review_count, { compact: true })}</div>
            <span class="trend-card__stat">${icon('download', 'icon--sm')}${fmtNumber(b.total_downloads)} downloads</span>
          </div>
        </button>`
        )
        .join('');
    } catch (err) {
      shelf.innerHTML = `<div class="empty"><h3>Trending is unavailable</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  /* ------------------------------- Catalog ------------------------------- */

  function skeletonCards(n) {
    return Array.from(
      { length: n },
      () => `<div class="card" aria-hidden="true"><div class="skeleton skeleton--cover"></div>
        <div class="skeleton skeleton--line" style="width:40%"></div><div class="skeleton skeleton--line" style="width:85%"></div>
        <div class="skeleton skeleton--line" style="width:60%"></div></div>`
    ).join('');
  }

  function bookCard(b, i) {
    const on = state.bookmarks.has(b.book_id);
    return `
      <article class="card" style="animation-delay:${Math.min(i, 12) * 35}ms">
        <button type="button" class="heart ${on ? 'is-on' : ''}" data-action="bookmark" data-id="${b.book_id}"
          aria-pressed="${on}" aria-label="${on ? 'Remove bookmark' : 'Bookmark'}: ${esc(b.title)}">${icon('heart')}</button>
        <button type="button" class="card__cover-btn" data-action="open-book" data-id="${b.book_id}" aria-label="View details: ${esc(b.title)}">
          ${coverHtml(b, false)}
        </button>
        <div class="card__body">
          <span class="tag ${b.category_name ? '' : 'tag--muted'}">${esc(b.category_name || 'Uncategorized')}</span>
          <h3 class="card__title"><button type="button" data-action="open-book" data-id="${b.book_id}">${esc(b.title)}</button></h3>
          <p class="card__author">${esc(b.author)}</p>
          <div class="card__rating">${starsHtml(b.avg_rating, b.review_count, { compact: true })}</div>
          <div class="card__foot">
            <span class="stat-inline" title="Total downloads">${icon('download', 'icon--sm')}${fmtNumber(b.total_downloads)}</span>
            <button type="button" class="btn btn--soft btn--sm" data-action="download" data-id="${b.book_id}">Download</button>
          </div>
        </div>
      </article>`;
  }

  function renderCatalogSlice({ quiet = false } = {}) {
    const grid = $('#catalogGrid');
    const moreWrap = $('#catalogMore');
    const books = state.catalogBooks;
    const shown = books.slice(0, state.catalogLimit);
    const remaining = Math.max(0, books.length - shown.length);

    grid.innerHTML = shown.length
      ? shown.map((b, i) => bookCard(b, quiet ? 0 : i)).join('')
      : `<div class="empty">
          <span class="empty__icon">${icon('search')}</span>
          <h3>No books match your filters</h3>
          <p>Try a different search term or category.</p>
          <button type="button" class="btn btn--ghost" data-action="reset-filters">Reset filters</button>
        </div>`;

    if (quiet) $$('.card', grid).forEach((c) => (c.style.animation = 'none'));

    moreWrap.innerHTML =
      remaining > 0
        ? `<button type="button" class="btn btn--ghost btn--lg" data-action="show-more-books">Show more books (${remaining} remaining)</button>`
        : books.length > PAGE_SIZE
          ? `<button type="button" class="btn btn--ghost btn--sm" data-action="collapse-books">Show fewer books</button>`
          : '';
  }

  async function loadCatalog({ quiet = false, resetPage = true } = {}) {
    const grid = $('#catalogGrid');
    const seq = ++state.catalogSeq;
    if (resetPage) state.catalogLimit = PAGE_SIZE;
    if (!state.catalogLoaded && !quiet) grid.innerHTML = skeletonCards(8);
    grid.setAttribute('aria-busy', 'true');

    const params = new URLSearchParams({ sort: state.sort });
    if (state.categoryId) params.set('category_id', state.categoryId);
    if (state.search) params.set('search', state.search);

    try {
      const { books, count } = await api(`/api/books?${params}`);
      if (seq !== state.catalogSeq) return;
      state.catalogLoaded = true;
      state.catalogBooks = books;
      const category = state.categories.find((c) => c.category_id === state.categoryId);
      $('#resultCount').textContent =
        `${count} ${count === 1 ? 'book' : 'books'}` +
        (category ? ` in ${category.category_name}` : '') +
        (state.search ? ` matching \u201c${state.search}\u201d` : '');

      renderCatalogSlice({ quiet });
    } catch (err) {
      if (seq !== state.catalogSeq) return;
      grid.innerHTML = `<div class="empty"><span class="empty__icon">${icon('alert')}</span><h3>Could not load the catalog</h3><p>${esc(err.message)}</p></div>`;
      $('#catalogMore').innerHTML = '';
    } finally {
      if (seq === state.catalogSeq) grid.removeAttribute('aria-busy');
    }
  }

  /* ------------------ Community Requests & Leaderboard ------------------- */

  async function loadRequests() {
    const wrap = $('#requestsBoard');
    if (!wrap) return;
    try {
      const { requests } = await api('/api/requests');
      renderRequests(requests);
    } catch (err) {
      wrap.innerHTML = `<p class="table__sub">${esc(err.message)}</p>`;
    }
  }

  function renderRequests(requests) {
    const wrap = $('#requestsBoard');
    if (!wrap) return;
    if (!requests.length) {
      wrap.innerHTML = `<div class="empty"><h3>No requests yet</h3><p>Be the first reader to request a book for the library.</p></div>`;
      return;
    }
    const isAdmin = state.user && state.user.role === 'admin';
    wrap.innerHTML = requests
      .map(
        (r) => `
        <article class="req-card">
          <button type="button" class="vote-btn ${r.user_voted ? 'is-voted' : ''}" data-action="vote-request" data-id="${r.request_id}"
            aria-pressed="${Boolean(r.user_voted)}" title="${r.user_voted ? 'Remove upvote' : 'Upvote this request'}">
            <span class="vote-btn__arrow">▲</span>
            <span class="vote-btn__count">${fmtNumber(r.vote_count)}</span>
          </button>
          <div>
            <div class="req-card__top">
              <div class="req-card__title">${esc(r.title)}</div>
              <span class="badge-status badge-status--${esc(r.status)}">${r.status === 'fulfilled' ? '✓ Fulfilled' : 'Open'}</span>
            </div>
            <div class="req-card__author">by ${esc(r.author)}${r.isbn ? ` \u00b7 ISBN ${esc(r.isbn)}` : ''}</div>
            ${r.reason ? `<p class="req-card__reason">${esc(r.reason)}</p>` : ''}
            <div class="req-card__meta">
              <span>Requested by @${esc(r.requester_username)}</span>
              ${
                r.status === 'fulfilled' && r.fulfilled_book_id
                  ? `<button type="button" class="btn btn--soft btn--sm" data-action="open-book" data-id="${r.fulfilled_book_id}">View in Catalog</button>`
                  : isAdmin
                    ? `<button type="button" class="btn btn--ghost btn--sm" data-action="fulfill-request" data-id="${r.request_id}">Mark Fulfilled</button>`
                    : ''
              }
            </div>
          </div>
        </article>`
      )
      .join('');
  }

  async function toggleVote(requestId, btn) {
    if (!requireLogin({ type: 'vote', id: requestId }, 'Sign in to upvote book requests.')) return;
    if (btn) btn.disabled = true;
    try {
      const { requests } = await api(`/api/requests/${requestId}/vote`, { method: 'POST' });
      renderRequests(requests);
    } catch (err) {
      toast('error', 'Vote failed', err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function fulfillRequest(requestId, btn) {
    setLoading(btn, true);
    try {
      const { requests } = await api(`/api/admin/requests/${requestId}/fulfill`, { method: 'PATCH', body: {} });
      renderRequests(requests);
      toast('success', 'Request marked fulfilled');
    } catch (err) {
      toast('error', 'Could not update request', err.message);
    } finally {
      setLoading(btn, false);
    }
  }

  function openRequestModal() {
    if (!requireLogin({ type: 'open-request' }, 'Sign in to request a new book.')) return;
    const modal = $('#requestModal');
    const form = $('#requestForm');
    $('.form__error', form).classList.remove('is-visible');
    if (!modal.open) modal.showModal();
  }

  async function handleRequestSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const btn = $('button[type="submit"]', form);
    $('.form__error', form).classList.remove('is-visible');
    const data = Object.fromEntries(new FormData(form));
    setLoading(btn, true);
    try {
      const { requests } = await api('/api/requests', { method: 'POST', body: data });
      renderRequests(requests);
      form.reset();
      $('#requestModal').close();
      toast('success', 'Request submitted', 'Your request is live and upvoted on the board.');
    } catch (err) {
      showFormError(form, err.message);
    } finally {
      setLoading(btn, false);
    }
  }

  async function loadLeaderboard() {
    const wrap = $('#leaderboardList');
    if (!wrap) return;
    try {
      const { leaders } = await api('/api/leaderboard');
      if (!leaders.length) {
        wrap.innerHTML = `<div class="empty"><h3>No readers ranked yet</h3></div>`;
        return;
      }
      wrap.innerHTML = leaders
        .map(
          (l) => `
          <div class="leader-row">
            <span class="leader-rank">#${l.rank_pos}</span>
            <span class="avatar avatar--sm" aria-hidden="true">${esc(initials(l.full_name))}</span>
            <div class="leader-info">
              <div class="leader-name">${esc(l.full_name)} <span class="table__sub">@${esc(l.username)}</span></div>
              <div class="leader-stats">${fmtNumber(l.downloads_count)} downloads \u00b7 ${fmtNumber(l.reviews_count)} reviews \u00b7 ${fmtNumber(l.notes_count)} notes \u00b7 ${fmtNumber(l.pages_read)} pages</div>
            </div>
            <span class="leader-score">${fmtNumber(l.engagement_score)} pts</span>
          </div>`
        )
        .join('');
    } catch (err) {
      wrap.innerHTML = `<p class="table__sub">${esc(err.message)}</p>`;
    }
  }

  function refreshAll() {
    return Promise.all([
      loadStats(),
      loadCategories(),
      loadTrending(),
      loadCatalog({ quiet: true, resetPage: false }),
      loadRequests(),
      loadLeaderboard(),
    ]);
  }

  /* ---------------------------- Book actions ----------------------------- */

  function triggerFileDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadBook(id, btn) {
    if (!requireLogin({ type: 'download', id }, 'Sign in to download this book.')) return;
    setLoading(btn, true);
    try {
      const { downloadUrl, filename, total_downloads } = await api(`/api/books/${id}/download`, { method: 'POST' });
      triggerFileDownload(downloadUrl, filename);
      toast('success', 'Download started', 'A copy has been added to your download history.');
      $$(`[data-book-downloads="${id}"]`).forEach((el) => (el.textContent = fmtNumber(total_downloads)));
      loadStats();
      loadTrending();
      loadCatalog({ quiet: true, resetPage: false });
      loadLeaderboard();
      if ($('#libraryModal').open) loadLibrary();
    } catch (err) {
      toast('error', 'Download failed', err.message);
    } finally {
      setLoading(btn, false);
    }
  }

  async function toggleBookmark(id, btn) {
    if (!requireLogin({ type: 'bookmark', id }, 'Sign in to save books to your library.')) return;
    if (btn) btn.disabled = true;
    try {
      const { bookmarked } = await api(`/api/books/${id}/bookmark`, { method: 'POST' });
      if (bookmarked) state.bookmarks.add(id);
      else state.bookmarks.delete(id);
      updateBookmarkUI(id);
      toast(bookmarked ? 'success' : 'info', bookmarked ? 'Saved to your library' : 'Bookmark removed');
      if ($('#libraryModal').open) loadLibrary();
    } catch (err) {
      toast('error', 'Could not update bookmark', err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function updateBookmarkUI(popId) {
    $$('.heart[data-id]').forEach((el) => {
      const id = Number(el.dataset.id);
      const on = state.bookmarks.has(id);
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', String(on));
      if (id === popId && !reduceMotion) {
        el.classList.remove('pop');
        void el.offsetWidth;
        el.classList.add('pop');
      }
    });
    $$('.btn--bookmark[data-id]').forEach((el) => {
      const on = state.bookmarks.has(Number(el.dataset.id));
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', String(on));
      el.querySelector('span').textContent = on ? 'Saved' : 'Save to library';
    });
  }

  function runPendingAction() {
    const action = state.pendingAction;
    state.pendingAction = null;
    if (!action) return;
    if (action.type === 'download') downloadBook(action.id);
    else if (action.type === 'bookmark') toggleBookmark(action.id);
    else if (action.type === 'library') openLibrary();
    else if (action.type === 'save-progress') saveReaderProgress();
    else if (action.type === 'vote') toggleVote(action.id);
    else if (action.type === 'open-request') openRequestModal();
  }

  /* ----------------------------- Book modal ------------------------------ */

  async function openBook(id, { preserveScroll = false } = {}) {
    const modal = $('#bookModal');
    const body = $('#bookModalBody');
    const scroll = modal.open ? modal.scrollTop : 0;
    state.currentBookId = id;
    if (!preserveScroll) {
      body.innerHTML = `<div class="detail"><div class="skeleton skeleton--cover"></div><div>
        <div class="skeleton skeleton--line" style="width:30%"></div><div class="skeleton skeleton--line" style="height:34px;width:80%"></div>
        <div class="skeleton skeleton--line" style="width:50%"></div><div class="skeleton skeleton--line" style="height:120px"></div></div></div>`;
    }
    if (!modal.open) modal.showModal();
    modal.scrollTop = preserveScroll ? scroll : 0;

    try {
      const data = await api(`/api/books/${id}`);
      if (state.currentBookId !== id) return;
      state.currentBook = data;
      const { book: b, recommendations, progress, notes } = data;
      if (state.user) {
        if (b.is_bookmarked) state.bookmarks.add(b.book_id);
        else state.bookmarks.delete(b.book_id);
      }
      const saved = state.bookmarks.has(b.book_id);
      const coDownloads = recommendations.some((r) => r.source === 'co-download');
      body.innerHTML = `
        <button type="button" class="icon-btn detail__close" data-close aria-label="Close">${icon('close')}</button>
        <div class="detail">
          <div class="detail__cover">${coverHtml(b)}</div>
          <div>
            <span class="tag ${b.category_name ? '' : 'tag--muted'}">${esc(b.category_name || 'Uncategorized')}</span>
            <h2 class="detail__title" id="bookModalTitle">${esc(b.title)}</h2>
            <p class="detail__author">by ${esc(b.author)}</p>
            <div class="detail__rating" data-book-rating="${b.book_id}">${starsHtml(b.avg_rating, b.review_count)}</div>
            <dl class="meta-grid">
              <div><dt>Published</dt><dd>${esc(b.published_year ?? '-')}</dd></div>
              <div><dt>Pages</dt><dd>${b.pages ? fmtNumber(b.pages) : '-'}</dd></div>
              <div><dt>ISBN</dt><dd>${esc(b.isbn || '-')}</dd></div>
              <div><dt>Downloads</dt><dd data-book-downloads="${b.book_id}">${fmtNumber(b.total_downloads)}</dd></div>
            </dl>
            <p class="detail__desc">${esc(b.description || 'No description has been added for this title yet.')}</p>
            ${
              progress
                ? `<div class="detail__progress">${progressBadge(progress)}
                    <div class="meter"><div class="meter__fill" style="width:${progressPct(progress)}%"></div></div>
                    <span class="detail__progress-pct">${progressPct(progress)}%</span></div>`
                : ''
            }
            <div class="detail__actions">
              <button type="button" class="btn btn--primary btn--lg" data-action="download" data-id="${b.book_id}">${icon('download')}Download PDF</button>
              <button type="button" class="btn btn--outline btn--lg" data-action="read" data-id="${b.book_id}">${icon('read')}${progress ? 'Continue Reading' : `Read Online${notes && notes.length ? ` (${notes.length} notes)` : ''}`}</button>
              <button type="button" class="btn btn--ghost btn--lg btn--bookmark ${saved ? 'is-on' : ''}" data-action="bookmark"
                data-id="${b.book_id}" aria-pressed="${saved}">${icon('heart')}<span>${saved ? 'Saved' : 'Save to library'}</span></button>
            </div>
          </div>
        </div>
        ${renderReviews(data)}
        ${
          recommendations.length
            ? `<div class="related">
                <div class="related__head">
                  <h3>Readers Also Downloaded</h3>
                  <span>${coDownloads ? 'Based on what readers of this book also downloaded' : `More from ${esc(b.category_name || 'the catalog')}`}</span>
                </div>
                <div class="related__grid">
                ${recommendations
                  .map(
                    (r) => `<button type="button" class="mini" data-action="open-book" data-id="${r.book_id}">
                      ${coverHtml(r, false)}<span class="mini__title">${esc(r.title)}</span><span class="mini__author">${esc(r.author)}</span>
                      ${starsHtml(r.avg_rating, r.review_count, { compact: true })}</button>`
                  )
                  .join('')}
                </div>
              </div>`
            : ''
        }`;
    } catch (err) {
      body.innerHTML = `<button type="button" class="icon-btn detail__close" data-close aria-label="Close">${icon('close')}</button>
        <div class="empty" style="margin:32px"><span class="empty__icon">${icon('alert')}</span><h3>Book unavailable</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderReviews({ book: b, reviews, my_review: mine, has_downloaded: downloaded }) {
    let composer;
    if (!state.user) {
      composer = `<div class="reviews__gate">${icon('shield')}<p>Sign in and download this book to leave a verified review.</p>
        <button type="button" class="btn btn--ghost btn--sm" data-action="open-auth" data-tab="login">Sign in</button></div>`;
    } else if (!downloaded) {
      composer = `<div class="reviews__gate">${icon('shield')}<p>Download this book first to leave a verified review.</p>
        <button type="button" class="btn btn--soft btn--sm" data-action="download" data-id="${b.book_id}">${icon('download', 'icon--sm')}Download</button></div>`;
    } else {
      const current = mine ? mine.rating : 0;
      composer = `<form class="review-form" id="reviewForm" data-id="${b.book_id}" novalidate>
        <div class="review-form__row">
          <span class="review-form__label">${mine ? 'Update your rating' : 'Your rating'}</span>
          <div class="star-input" role="radiogroup" aria-label="Your rating">
            ${[5, 4, 3, 2, 1]
              .map(
                (v) => `<input type="radio" id="star-${v}" name="rating" value="${v}" ${current === v ? 'checked' : ''} />
                  <label for="star-${v}" title="${v} star${v > 1 ? 's' : ''}">★</label>`
              )
              .join('')}
          </div>
        </div>
        <textarea name="comment" rows="3" maxlength="1000" placeholder="What did you think of this book? (optional)">${esc(mine ? mine.comment || '' : '')}</textarea>
        <p class="form__error" role="alert"></p>
        <div class="review-form__actions">
          <span class="badge-verified">${icon('shield', 'icon--sm')}You downloaded this book</span>
          <button type="submit" class="btn btn--primary">${mine ? 'Update review' : 'Post review'}</button>
        </div>
      </form>`;
    }

    const list = reviews.length
      ? reviews
          .map(
            (r) => `<article class="review">
              <div class="review__head">
                <span class="avatar avatar--sm" aria-hidden="true">${esc(initials(r.full_name))}</span>
                <div class="review__who"><strong>${esc(r.full_name)}</strong><span>@${esc(r.username)} \u00b7 ${esc(fmtDate(r.created_at))}</span></div>
                <span class="stars stars--sm" style="--pct:${(r.rating / 5) * 100}%" role="img" aria-label="${r.rating} out of 5">★★★★★</span>
              </div>
              <span class="badge-verified">${icon('shield', 'icon--sm')}Verified download</span>
              ${r.comment ? `<p class="review__text">${esc(r.comment)}</p>` : ''}
            </article>`
          )
          .join('')
      : `<p class="reviews__empty">No reviews yet. Be the first verified reader to share your thoughts.</p>`;

    return `<section class="reviews" aria-labelledby="reviewsTitle">
      <div class="reviews__head">
        <h3 id="reviewsTitle">Verified Reader Reviews</h3>
        ${starsHtml(b.avg_rating, b.review_count)}
      </div>
      ${composer}
      <div class="reviews__list">${list}</div>
    </section>`;
  }

  async function submitReview(form) {
    const id = Number(form.dataset.id);
    const btn = $('button[type="submit"]', form);
    const err = $('.form__error', form);
    err.classList.remove('is-visible');
    const rating = Number((form.querySelector('input[name="rating"]:checked') || {}).value);
    if (!rating) return showFormError(form, 'Choose a rating from 1 to 5 stars.');
    setLoading(btn, true);
    try {
      const res = await api(`/api/books/${id}/reviews`, { method: 'POST', body: { rating, comment: form.comment.value } });
      toast('success', 'Review saved', `Average rating is now ${Number(res.book.avg_rating).toFixed(1)} from ${res.book.review_count} review${res.book.review_count === 1 ? '' : 's'}.`);
      await openBook(id, { preserveScroll: true });
      loadCatalog({ quiet: true, resetPage: false });
      loadTrending();
      loadLeaderboard();
    } catch (e) {
      showFormError(form, e.message);
      setLoading(btn, false);
    }
  }

  /* ----------------------- PDF reader + Study Notes ---------------------- */

  async function openReaderById(id) {
    try {
      const data = await api(`/api/books/${id}`);
      openReader(data.book, data.progress, data.notes || []);
    } catch (err) {
      toast('error', 'Could not open the reader', err.message);
    }
  }

  function readerPdfSrc(book, page) {
    return `${book.file_path}?page=${page}#page=${page}&view=FitH`;
  }

  function openReader(book, progress, notes = []) {
    const modal = $('#readerModal');
    const form = $('#readerForm');
    const total = (progress && progress.total_pages) || book.pdf_pages || book.pages || 1;
    const current = Math.min((progress && progress.current_page) || 1, total);
    state.reader = { book, notes };
    $('#readerTitle').textContent = book.title;
    form.current_page.value = current;
    form.total_pages.value = total;
    form.current_page.max = total;
    $('#readerFrame').src = readerPdfSrc(book, current);
    updateReaderMeter();
    renderReaderNotes(notes);
    $('#readerStatus').textContent = progress
      ? `Last saved ${fmtDate(progress.updated_at, true)}`
      : state.user
        ? 'Not saved yet - update the page and press Save Progress.'
        : 'Sign in to save your reading progress and study notes.';
    if (!modal.open) modal.showModal();
  }

  function renderReaderNotes(notes) {
    const list = $('#readerNotesList');
    if (!list) return;
    if (!notes || !notes.length) {
      list.innerHTML = `<p class="table__sub">No study notes for this book yet. Anchor one to the current page above.</p>`;
      return;
    }
    const uid = state.user ? state.user.user_id : null;
    list.innerHTML = notes
      .map(
        (n) => `
        <article class="note-card">
          <div class="note-card__top">
            <button type="button" class="note-card__page" data-action="jump-page" data-page="${n.page_number}">Page ${n.page_number}</button>
            <span class="table__sub">${n.is_public ? 'Public' : 'Private'}</span>
          </div>
          <p class="note-card__text">${esc(n.note_text)}</p>
          <div class="note-card__foot">
            <span>@${esc(n.username)}</span>
            ${uid === n.user_id ? `<button type="button" class="btn btn--danger btn--sm" data-action="delete-note" data-id="${n.note_id}">Delete</button>` : ''}
          </div>
        </article>`
      )
      .join('');
  }

  async function handleNoteSubmit(event) {
    event.preventDefault();
    if (!state.reader) return;
    if (!requireLogin({ type: 'open-book', id: state.reader.book.book_id }, 'Sign in to save page-anchored study notes.')) return;
    const form = event.currentTarget;
    const text = form.note_text.value.trim();
    if (!text) return toast('error', 'Write a note before saving');
    const v = readerValues();
    const page = Number.isInteger(v.current) && v.current >= 1 ? v.current : 1;
    const btn = $('button[type="submit"]', form);
    setLoading(btn, true);
    try {
      const { notes } = await api(`/api/books/${state.reader.book.book_id}/notes`, {
        method: 'POST',
        body: { page_number: page, note_text: text, is_public: form.is_public.checked },
      });
      state.reader.notes = notes;
      renderReaderNotes(notes);
      form.note_text.value = '';
      toast('success', `Note saved on Page ${page}`);
      loadLeaderboard();
    } catch (err) {
      toast('error', 'Could not save note', err.message);
    } finally {
      setLoading(btn, false);
    }
  }

  async function deleteNote(noteId, btn) {
    if (!state.reader) return;
    setLoading(btn, true);
    try {
      const { notes } = await api(`/api/books/${state.reader.book.book_id}/notes/${noteId}`, { method: 'DELETE' });
      state.reader.notes = notes;
      renderReaderNotes(notes);
      toast('info', 'Study note removed');
      loadLeaderboard();
    } catch (err) {
      toast('error', 'Could not delete note', err.message);
      setLoading(btn, false);
    }
  }

  function readerValues() {
    const form = $('#readerForm');
    return { current: Number(form.current_page.value), total: Number(form.total_pages.value) };
  }

  function readerError({ current, total }) {
    if (!Number.isInteger(total) || total < 1) return 'Total pages must be a whole number of at least 1.';
    if (!Number.isInteger(current) || current < 1) return 'Current page must be a whole number of at least 1.';
    if (current > total) return 'Current page cannot be greater than total pages.';
    return null;
  }

  function updateReaderMeter() {
    const v = readerValues();
    const ok = !readerError(v);
    $('#readerMeter').style.width = ok ? `${Math.round((v.current / v.total) * 100)}%` : '0%';
    $('#readerForm').current_page.max = Number.isInteger(v.total) && v.total > 0 ? v.total : '';
    const badge = $('#notesPageBadge');
    if (badge) badge.textContent = `Page ${ok ? v.current : 1}`;
  }

  async function saveReaderProgress() {
    if (!state.reader) return;
    const { book } = state.reader;
    if (!requireLogin({ type: 'save-progress' }, 'Sign in to save your reading progress.')) return;
    const v = readerValues();
    const problem = readerError(v);
    if (problem) {
      $('#readerStatus').textContent = problem;
      $('#readerStatus').classList.add('is-error');
      return;
    }
    $('#readerStatus').classList.remove('is-error');
    const btn = $('#readerForm button[type="submit"]');
    setLoading(btn, true);
    try {
      const { progress } = await api(`/api/books/${book.book_id}/progress`, {
        method: 'PUT',
        body: { current_page: v.current, total_pages: v.total },
      });
      $('#readerStatus').textContent = `Saved \u00b7 Page ${progress.current_page} of ${progress.total_pages} (${progressPct(progress)}%)`;
      toast('success', 'Progress saved', `Page ${progress.current_page} of ${progress.total_pages} in "${book.title}".`);
      loadLeaderboard();
      if ($('#bookModal').open && state.currentBookId === book.book_id) openBook(book.book_id, { preserveScroll: true });
      if ($('#libraryModal').open) loadLibrary();
    } catch (err) {
      $('#readerStatus').textContent = err.message;
      $('#readerStatus').classList.add('is-error');
    } finally {
      setLoading(btn, false);
    }
  }

  /* ----------------------------- Auth modal ------------------------------ */

  function setAuthTab(tab) {
    $$('[data-auth-tab]').forEach((b) => {
      const active = b.dataset.authTab === tab;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $('#loginForm').hidden = tab !== 'login';
    $('#registerForm').hidden = tab !== 'register';
    $('#authTitle').textContent = tab === 'login' ? 'Welcome back' : 'Create your account';
  }

  function openAuth(tab = 'login', message) {
    const modal = $('#authModal');
    setAuthTab(tab);
    $('.modal__subtitle', modal).textContent = message || 'Sign in to download books and save bookmarks.';
    $$('.form__error', modal).forEach((e) => e.classList.remove('is-visible'));
    if (!modal.open) modal.showModal();
    const first = $(`#${tab === 'login' ? 'loginForm' : 'registerForm'} input`);
    if (first) first.focus();
  }

  function showFormError(form, message) {
    const el = $('.form__error', form);
    el.textContent = message;
    el.classList.add('is-visible');
  }

  async function handleAuthSubmit(event, mode) {
    event.preventDefault();
    const form = event.currentTarget;
    const btn = $('button[type="submit"]', form);
    $('.form__error', form).classList.remove('is-visible');
    const data = Object.fromEntries(new FormData(form));
    setLoading(btn, true);
    try {
      const { token, user } = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        body: data,
      });
      await setSession(token, user);
      $('#authModal').close();
      form.reset();
      toast('success', mode === 'login' ? `Welcome back, ${user.full_name.split(' ')[0]}` : 'Account created', user.role === 'admin' ? 'Admin Studio is now available.' : 'You can now download and bookmark books.');
      loadStats();
      loadLeaderboard();
      if ($('#bookModal').open && state.currentBookId) openBook(state.currentBookId, { preserveScroll: true });
      runPendingAction();
    } catch (err) {
      showFormError(form, err.message);
    } finally {
      setLoading(btn, false);
    }
  }

  /* ---------------------------- Library modal ---------------------------- */

  function openLibrary() {
    if (!requireLogin({ type: 'library' }, 'Sign in to view your library.')) return;
    const modal = $('#libraryModal');
    if (!modal.open) modal.showModal();
    loadLibrary(true);
  }

  async function loadLibrary(showSkeleton = false) {
    const content = $('#libraryContent');
    if (showSkeleton) {
      content.innerHTML = `<div class="summary">${'<div class="summary__item"><div class="skeleton skeleton--line" style="height:30px;width:40%"></div><div class="skeleton skeleton--line" style="width:70%"></div></div>'.repeat(4)}</div>
        <div class="skeleton" style="height:240px"></div>`;
    }
    try {
      const data = await api('/api/user/dashboard');
      state.bookmarks = new Set(data.bookmarks.map((b) => b.book_id));
      updateBookmarkUI();
      $('#librarySubtitle').textContent = `${data.user.full_name} \u00b7 member since ${fmtDate(data.user.created_at)}`;
      renderLibrary(data);
    } catch (err) {
      content.innerHTML = `<div class="empty"><span class="empty__icon">${icon('alert')}</span><h3>Could not load your library</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderLibrary(data) {
    const { summary, downloads, bookmarks, reading_progress: reading } = data;
    const tab = state.libraryTab;
    const progressByBook = new Map(reading.map((p) => [p.book_id, p]));
    const seenInHistory = new Set();

    const history = downloads.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Book</th><th>Category</th><th>Downloaded</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${downloads
            .map(
              (d) => {
                const p = !seenInHistory.has(d.book_id) && progressByBook.get(d.book_id);
                seenInHistory.add(d.book_id);
                return `<tr>
                <td><div class="table__book">${coverHtml(d, false)}<div><div class="table__title">${esc(d.title)}</div><div class="table__sub">${esc(d.author)}</div>${p ? progressBadge(p) : ''}</div></div></td>
                <td><span class="tag ${d.category_name ? '' : 'tag--muted'}">${esc(d.category_name || 'Uncategorized')}</span></td>
                <td class="table__num">${esc(fmtDate(d.downloaded_at, true))}</td>
                <td style="text-align:right;white-space:nowrap">
                  <button type="button" class="btn btn--ghost btn--sm" data-action="open-book" data-id="${d.book_id}">${icon('eye', 'icon--sm')}Details</button>
                  <button type="button" class="btn btn--soft btn--sm" data-action="download" data-id="${d.book_id}">${icon('download', 'icon--sm')}Again</button>
                </td>
              </tr>`;
              }
            )
            .join('')}</tbody></table></div>`
      : `<div class="empty"><span class="empty__icon">${icon('download')}</span><h3>No downloads yet</h3><p>Books you download appear here, newest first.</p>
          <button type="button" class="btn btn--primary" data-action="go-catalog">Browse the catalog</button></div>`;

    const progressList = reading.length
      ? `<div class="progress-list">${reading
          .map(
            (p) => `<article class="progress-card">
              <button type="button" class="progress-card__cover" data-action="open-book" data-id="${p.book_id}" aria-label="Details: ${esc(p.title)}">
                ${coverHtml({ title: p.title, cover_path: p.cover_url }, false)}</button>
              <div class="progress-card__body">
                <div class="table__title">${esc(p.title)}</div>
                <div class="table__sub">${esc(p.author)}</div>
                <div class="progress-card__meter">
                  <div class="meter"><div class="meter__fill" style="width:${progressPct(p)}%"></div></div>
                  <span>${progressPct(p)}%</span>
                </div>
                <div class="progress-card__foot">
                  ${progressBadge(p)}
                  <span class="table__sub">Updated ${esc(fmtDate(p.updated_at))}</span>
                </div>
              </div>
              <button type="button" class="btn btn--soft btn--sm" data-action="read" data-id="${p.book_id}">${icon('read', 'icon--sm')}Continue</button>
            </article>`
          )
          .join('')}</div>`
      : `<div class="empty"><span class="empty__icon">${icon('read')}</span><h3>Nothing in progress</h3><p>Open a book with Read Online and save your page to track it here.</p></div>`;

    const saved = bookmarks.length
      ? `<div class="saved-grid">${bookmarks
          .map(
            (b) => `<div class="saved">
              <button type="button" class="heart is-on" data-action="bookmark" data-id="${b.book_id}" aria-pressed="true" aria-label="Remove bookmark: ${esc(b.title)}">${icon('heart')}</button>
              <button type="button" class="mini" data-action="open-book" data-id="${b.book_id}">${coverHtml(b, false)}
                <span class="mini__title">${esc(b.title)}</span><span class="mini__author">${esc(b.author)}</span></button>
            </div>`
          )
          .join('')}</div>`
      : `<div class="empty"><span class="empty__icon">${icon('heart')}</span><h3>No saved books</h3><p>Tap the heart on any book to save it here.</p></div>`;

    $('#libraryContent').innerHTML = `
      <div class="summary">
        <div class="summary__item"><div class="summary__value">${fmtNumber(summary.total_downloads)}</div><div class="summary__label">Total downloads</div></div>
        <div class="summary__item"><div class="summary__value">${fmtNumber(summary.unique_books)}</div><div class="summary__label">Unique books</div></div>
        <div class="summary__item"><div class="summary__value">${fmtNumber(summary.in_progress)}</div><div class="summary__label">Currently reading</div></div>
        <div class="summary__item"><div class="summary__value">${fmtNumber(summary.total_bookmarks)}</div><div class="summary__label">Saved bookmarks</div></div>
      </div>
      <div class="segmented" role="tablist">
        <button type="button" class="segmented__btn ${tab === 'downloads' ? 'is-active' : ''}" data-action="library-tab" data-tab="downloads" role="tab" aria-selected="${tab === 'downloads'}">Download history<span class="segmented__count">${downloads.length}</span></button>
        <button type="button" class="segmented__btn ${tab === 'progress' ? 'is-active' : ''}" data-action="library-tab" data-tab="progress" role="tab" aria-selected="${tab === 'progress'}">Currently reading<span class="segmented__count">${reading.length}</span></button>
        <button type="button" class="segmented__btn ${tab === 'saved' ? 'is-active' : ''}" data-action="library-tab" data-tab="saved" role="tab" aria-selected="${tab === 'saved'}">Saved bookmarks<span class="segmented__count">${bookmarks.length}</span></button>
      </div>
      <div data-library-panel="downloads" ${tab === 'downloads' ? '' : 'hidden'}>${history}</div>
      <div data-library-panel="progress" ${tab === 'progress' ? '' : 'hidden'}>${progressList}</div>
      <div data-library-panel="saved" ${tab === 'saved' ? '' : 'hidden'}>${saved}</div>`;
  }

  function setLibraryTab(tab) {
    state.libraryTab = tab;
    $$('[data-action="library-tab"]').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $$('[data-library-panel]').forEach((p) => (p.hidden = p.dataset.libraryPanel !== tab));
  }

  /* ----------------------------- Admin modal ----------------------------- */

  function openAdmin() {
    if (!state.user || state.user.role !== 'admin') {
      toast('error', 'Administrator access required');
      return;
    }
    const modal = $('#adminModal');
    if (!modal.open) modal.showModal();
    setAdminTab(state.adminTab);
  }

  function setAdminTab(tab) {
    state.adminTab = tab;
    $$('[data-admin-tab]').forEach((b) => {
      const active = b.dataset.adminTab === tab;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $('#adminForm').hidden = tab !== 'add';
    $('#adminManage').hidden = tab !== 'manage';
    $('#adminAudit').hidden = tab !== 'audit';
    if (tab === 'manage') loadAdminBooks();
    if (tab === 'audit') loadAuditLogs();
  }

  async function loadAuditLogs() {
    const wrap = $('#adminAudit');
    if (!wrap.childElementCount) wrap.innerHTML = '<div class="skeleton" style="height:280px"></div>';
    try {
      const { logs } = await api('/api/admin/audit-logs');
      const rows = logs
        .map(
          (l) => `<tr>
            <td class="table__num">${esc(fmtDate(l.created_at, true))}</td>
            <td><span class="badge-action badge-action--${esc(String(l.action_type).toLowerCase())}">${esc(l.action_type)}</span></td>
            <td class="table__num">${esc(l.entity_type)}${l.entity_id != null ? ` #${esc(l.entity_id)}` : ''}</td>
            <td>${esc(l.details || '')}</td>
          </tr>`
        )
        .join('');
      wrap.innerHTML = `<div class="manage-head">
          <span class="table__sub">Latest ${logs.length} events, written automatically by database triggers.</span>
          <button type="button" class="btn btn--ghost btn--sm" data-action="refresh-audit">Refresh</button>
        </div>
        ${
          logs.length
            ? `<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>`
            : '<div class="empty"><h3>No audit events yet</h3></div>'
        }`;
    } catch (err) {
      wrap.innerHTML = `<div class="empty"><h3>Could not load the audit trail</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  async function loadAdminBooks() {
    const wrap = $('#adminManage');
    if (!state.adminBooks.length) wrap.innerHTML = '<div class="skeleton" style="height:280px"></div>';
    try {
      const { books } = await api('/api/books?sort=newest');
      state.adminBooks = books;
      renderAdminBooks();
    } catch (err) {
      wrap.innerHTML = `<div class="empty"><h3>Could not load books</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderAdminBooks() {
    const wrap = $('#adminManage');
    const filterInput = $('#adminFilter');
    const term = filterInput ? filterInput.value.trim().toLowerCase() : '';
    const rows = state.adminBooks.filter(
      (b) => !term || `${b.title} ${b.author} ${b.isbn || ''}`.toLowerCase().includes(term)
    );
    const tableHtml = rows.length
      ? `<table class="table"><thead><tr><th>Book</th><th>Category</th><th>Downloads</th><th>Added</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows
          .map(
            (b) => `<tr>
              <td><div class="table__book">${coverHtml(b, false)}<div><div class="table__title">${esc(b.title)}</div><div class="table__sub">${esc(b.author)}${b.isbn ? ` \u00b7 ${esc(b.isbn)}` : ''}</div></div></div></td>
              <td><span class="tag ${b.category_name ? '' : 'tag--muted'}">${esc(b.category_name || 'Uncategorized')}</span></td>
              <td class="table__num">${fmtNumber(b.total_downloads)}</td>
              <td class="table__num">${esc(fmtDate(b.uploaded_at))}</td>
              <td style="text-align:right"><button type="button" class="btn btn--danger btn--sm" data-action="admin-delete" data-id="${b.book_id}">${icon('trash', 'icon--sm')}Delete</button></td>
            </tr>`
          )
          .join('')}</tbody></table>`
      : `<div class="empty" style="border:none"><h3>No matching books</h3></div>`;

    if (!filterInput) {
      wrap.innerHTML = `<div class="manage-head">
          <input type="search" id="adminFilter" placeholder="Filter by title, author or ISBN" aria-label="Filter books" />
          <span class="table__sub" id="adminCount"></span>
        </div>
        <div class="table-wrap" id="adminTable"></div>`;
      $('#adminFilter').addEventListener('input', debounce(renderAdminBooks, 150));
    }
    $('#adminTable').innerHTML = tableHtml;
    $('#adminCount').textContent = `${rows.length} of ${state.adminBooks.length} books`;
  }

  async function deleteBook(id, btn) {
    const book = state.adminBooks.find((b) => b.book_id === id);
    const name = book ? `"${book.title}"` : 'this book';
    if (!window.confirm(`Delete ${name}? It will also disappear from every reader's history and saved books.`)) return;
    setLoading(btn, true);
    try {
      await api(`/api/admin/books/${id}`, { method: 'DELETE' });
      state.bookmarks.delete(id);
      state.adminBooks = state.adminBooks.filter((b) => b.book_id !== id);
      renderAdminBooks();
      toast('success', 'Book deleted', `${book ? book.title : 'The book'} and its files were removed.`);
      if ($('#bookModal').open && state.currentBookId === id) $('#bookModal').close();
      refreshAll();
    } catch (err) {
      toast('error', 'Delete failed', err.message);
      setLoading(btn, false);
    }
  }

  async function handleAdminSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const btn = $('button[type="submit"]', form);
    $('.form__error', form).classList.remove('is-visible');

    if (!form.title.value.trim() || !form.author.value.trim()) return showFormError(form, 'Title and author are required.');
    if (!form.bookFile.files.length) return showFormError(form, 'Please attach the book PDF.');

    const cover = form.cover.files[0];
    if (cover) {
      let size;
      try {
        size = await readImageSize(cover);
      } catch (e) {
        return showFormError(form, 'The cover image could not be read. Please choose a different file.');
      }
      if (size.width > 0 && size.width < MIN_COVER_WIDTH) {
        return showFormError(form, `Cover is only ${size.width}px wide. Please use an image at least ${MIN_COVER_WIDTH}px wide.`);
      }
    }

    const fd = new FormData(form);
    for (const [key, value] of Array.from(fd.entries())) {
      if (value instanceof File && value.size === 0 && !value.name) fd.delete(key);
    }

    setLoading(btn, true);
    try {
      const { book } = await api('/api/admin/books', { method: 'POST', formData: fd });
      toast('success', 'Book published', `"${book.title}" is now in the catalog.`);
      form.reset();
      resetDropzones(form);
      state.adminBooks = [];
      await refreshAll();
    } catch (err) {
      showFormError(form, err.message);
    } finally {
      setLoading(btn, false);
    }
  }

  function resetDropzones(root) {
    $$('[data-dropzone]', root).forEach((zone) => {
      zone.classList.remove('has-file', 'is-drag');
      const hint = $('.dropzone__hint', zone);
      hint.textContent = hint.dataset.default;
    });
  }

  function initDropzones() {
    $$('[data-dropzone]').forEach((zone) => {
      const input = $('input[type="file"]', zone);
      const hint = $('.dropzone__hint', zone);
      input.addEventListener('change', () => {
        const file = input.files[0];
        zone.classList.toggle('has-file', Boolean(file));
        zone.classList.remove('has-error');
        const formError = zone.closest('form') && $('.form__error', zone.closest('form'));
        if (formError) formError.classList.remove('is-visible');
        hint.textContent = file ? `${file.name} \u00b7 ${fmtBytes(file.size)}` : hint.dataset.default;
        if (file && input.name === 'cover') checkCoverResolution(file, zone, hint);
      });
      ['dragenter', 'dragover'].forEach((ev) => input.addEventListener(ev, () => zone.classList.add('is-drag')));
      ['dragleave', 'drop'].forEach((ev) => input.addEventListener(ev, () => zone.classList.remove('is-drag')));
    });
  }

  function readImageSize(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(url);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('unreadable image'));
      };
      img.src = url;
    });
  }

  async function checkCoverResolution(file, zone, hint) {
    try {
      const { width, height } = await readImageSize(file);
      if (width > 0 && width < MIN_COVER_WIDTH) {
        zone.classList.remove('has-file');
        zone.classList.add('has-error');
        hint.textContent = `${width} \u00d7 ${height}px - too small, minimum width is ${MIN_COVER_WIDTH}px`;
      } else {
        hint.textContent = width ? `${file.name} \u00b7 ${width} \u00d7 ${height}px` : `${file.name} \u00b7 vector image`;
      }
    } catch (e) {
      zone.classList.remove('has-file');
      zone.classList.add('has-error');
      hint.textContent = 'This image could not be read';
    }
  }

  /* ------------------------------ Navigation ----------------------------- */

  const SECTION_IDS = ['top', 'trending', 'catalog', 'community'];
  const nav = { lockedId: null, releaseTimer: 0 };

  function sectionEl(id) {
    return id === 'top' ? $('.hero') : document.getElementById(id);
  }

  function navOffset() {
    return $('#navbar').getBoundingClientRect().height;
  }

  function setActiveNav(id) {
    $$('.nav-link').forEach((link) => {
      const on = link.dataset.section === id;
      link.classList.toggle('is-active', on);
      if (on) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  function sectionInView() {
    const doc = document.documentElement;
    if (window.scrollY + window.innerHeight >= doc.scrollHeight - 4) return SECTION_IDS[SECTION_IDS.length - 1];
    const line = navOffset() + (window.innerHeight - navOffset()) * 0.3;
    let current = SECTION_IDS[0];
    for (const id of SECTION_IDS) {
      if (sectionEl(id).getBoundingClientRect().top <= line) current = id;
    }
    return current;
  }

  function releaseNavLock() {
    clearTimeout(nav.releaseTimer);
    nav.lockedId = null;
  }

  function scrollToSection(id) {
    const el = sectionEl(id);
    if (!el) return;
    const top = id === 'top' ? 0 : Math.max(0, el.getBoundingClientRect().top + window.scrollY - navOffset() - 12);
    nav.lockedId = id;
    setActiveNav(id);
    clearTimeout(nav.releaseTimer);
    nav.releaseTimer = setTimeout(releaseNavLock, 1200);
    window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function initScrollUI() {
    const navbar = $('#navbar');
    let ticking = false;

    const onScroll = () => {
      navbar.classList.toggle('is-scrolled', window.scrollY > 8);
      if (nav.lockedId) {
        clearTimeout(nav.releaseTimer);
        nav.releaseTimer = setTimeout(releaseNavLock, 160);
        return;
      }
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        setActiveNav(sectionInView());
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    ['wheel', 'touchstart', 'keydown'].forEach((type) =>
      window.addEventListener(type, () => nav.lockedId && releaseNavLock(), { passive: true })
    );

    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) return;
      const id = link.getAttribute('href').slice(1);
      if (!SECTION_IDS.includes(id)) return;
      event.preventDefault();
      scrollToSection(id);
      if (link.classList.contains('skip-link')) {
        const target = sectionEl(id);
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    });

    if (location.hash) {
      const id = location.hash.slice(1);
      history.replaceState(null, '', location.pathname + location.search);
      if (SECTION_IDS.includes(id)) requestAnimationFrame(() => scrollToSection(id));
    }
    onScroll();
  }

  function initPillScroller() {
    const pills = $('#categoryPills');
    const update = () => {
      const max = pills.scrollWidth - pills.clientWidth;
      pills.classList.toggle('fade-start', pills.scrollLeft > 4);
      pills.classList.toggle('fade-end', pills.scrollLeft < max - 4);
    };
    pills.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    new MutationObserver(update).observe(pills, { childList: true });
    update();
  }

  /* ---------------------------- Event wiring ----------------------------- */

  function onDocumentClick(event) {
    const closer = event.target.closest('[data-close]');
    if (closer) {
      closer.closest('dialog').close();
      return;
    }

    const el = event.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id ? Number(el.dataset.id) : null;

    switch (el.dataset.action) {
      case 'toggle-theme':
        toggleTheme();
        break;
      case 'open-auth':
        openAuth(el.dataset.tab || 'login');
        break;
      case 'logout':
        clearSession();
        $$('dialog[open]').forEach((d) => d.close());
        toast('info', 'Signed out', 'See you next time.');
        break;
      case 'open-library':
        openLibrary();
        break;
      case 'library-tab':
        setLibraryTab(el.dataset.tab);
        break;
      case 'open-admin':
        openAdmin();
        break;
      case 'open-book':
        openBook(id);
        break;
      case 'bookmark':
        toggleBookmark(id, el);
        break;
      case 'download':
        downloadBook(id, el);
        break;
      case 'read': {
        const cur = state.currentBook;
        if (cur && cur.book.book_id === id) openReader(cur.book, cur.progress, cur.notes || []);
        else openReaderById(id);
        break;
      }
      case 'jump-page': {
        const page = Number(el.dataset.page);
        if (state.reader && page >= 1) {
          $('#readerForm').current_page.value = page;
          updateReaderMeter();
          $('#readerFrame').src = readerPdfSrc(state.reader.book, page);
        }
        break;
      }
      case 'delete-note':
        deleteNote(id, el);
        break;
      case 'open-request':
        openRequestModal();
        break;
      case 'vote-request':
        toggleVote(id, el);
        break;
      case 'fulfill-request':
        fulfillRequest(id, el);
        break;
      case 'refresh-audit':
        loadAuditLogs();
        break;
      case 'admin-delete':
        deleteBook(id, el);
        break;
      case 'category':
        state.categoryId = id;
        renderPills();
        loadCatalog();
        break;
      case 'show-more-books':
        state.catalogLimit += PAGE_SIZE;
        renderCatalogSlice({ quiet: true });
        break;
      case 'collapse-books':
        state.catalogLimit = PAGE_SIZE;
        renderCatalogSlice({ quiet: true });
        scrollToSection('catalog');
        break;
      case 'reset-filters':
        state.categoryId = null;
        state.search = '';
        $('#searchInput').value = '';
        renderPills();
        loadCatalog();
        break;
      case 'go-catalog':
        $$('dialog[open]').forEach((d) => d.close());
        scrollToSection('catalog');
        break;
      default:
        break;
    }
  }

  function init() {
    document.addEventListener('click', onDocumentClick);

    $$('dialog').forEach((dialog) => {
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
      });
    });
    $('#bookModal').addEventListener('close', () => (state.currentBookId = null));
    $('#readerModal').addEventListener('close', () => {
      state.reader = null;
      $('#readerFrame').src = 'about:blank';
      $('#readerStatus').classList.remove('is-error');
    });
    $('#authModal').addEventListener('close', () => {
      if (!state.user) state.pendingAction = null;
    });

    $('#beReaderBtn').addEventListener('click', () => openAuth('register', 'Create a free account to download, review and track your reading.'));
    $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.authTab)));
    $$('[data-admin-tab]').forEach((b) => b.addEventListener('click', () => setAdminTab(b.dataset.adminTab)));
    $('#loginForm').addEventListener('submit', (e) => handleAuthSubmit(e, 'login'));
    $('#registerForm').addEventListener('submit', (e) => handleAuthSubmit(e, 'register'));
    $('#adminForm').addEventListener('submit', handleAdminSubmit);
    $('#requestForm').addEventListener('submit', handleRequestSubmit);
    $('#noteForm').addEventListener('submit', handleNoteSubmit);

    const readerForm = $('#readerForm');
    readerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveReaderProgress();
    });
    readerForm.addEventListener('input', () => {
      $('#readerStatus').classList.remove('is-error');
      updateReaderMeter();
    });
    readerForm.current_page.addEventListener('change', () => {
      const v = readerValues();
      if (state.reader && !readerError(v)) $('#readerFrame').src = readerPdfSrc(state.reader.book, v.current);
    });

    document.addEventListener('submit', (e) => {
      if (e.target.id !== 'reviewForm') return;
      e.preventDefault();
      submitReview(e.target);
    });

    const onSearch = debounce((value) => {
      state.search = value.trim();
      loadCatalog();
    }, 300);
    $('#searchInput').addEventListener('input', (e) => onSearch(e.target.value));
    $('#sortSelect').addEventListener('change', (e) => {
      state.sort = e.target.value;
      loadCatalog();
    });

    initDropzones();
    initScrollUI();
    initPillScroller();

    restoreSession().finally(() => {
      loadStats();
      loadTrending();
      loadCategories().then(() => loadCatalog());
      loadRequests();
      loadLeaderboard();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
