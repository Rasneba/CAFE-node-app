(() => {
  const output = document.getElementById('menuOutput');
  const catsEl = document.getElementById('menuCats');
  const countEl = document.getElementById('menuCount');
  const searchEl = document.getElementById('menuSearch');
  const state = { items: [], categories: [], category: 'All items', query: '' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function money(value, currency) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0)} ${esc(currency || 'ETB')}`;
  }

  function renderCats() {
    const names = ['All items', ...state.categories.map((category) => category.name)];
    catsEl.innerHTML = names.map((name) => `<button class="menu-chip ${state.category === name ? 'active' : ''}" data-category="${esc(name)}">${esc(name)}</button>`).join('');
    catsEl.querySelectorAll('[data-category]').forEach((button) => {
      button.onclick = () => {
        state.category = button.dataset.category;
        renderCats();
        renderItems();
      };
    });
  }

  function filtered() {
    const query = state.query.trim().toLowerCase();
    return state.items.filter((item) => (state.category === 'All items' || item.category === state.category) && (!query || item.name.toLowerCase().includes(query) || String(item.description || '').toLowerCase().includes(query)));
  }

  function renderItems() {
    const items = filtered();
    countEl.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
    output.innerHTML = items.length
      ? `<div class="menu-grid">${items.map((item) => `<article class="menu-card">${item.image ? `<img src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy">` : ''}<div class="menu-card-body"><div class="menu-card-top"><h3>${esc(item.name)}</h3><span class="price">${money(item.price, window.__menuCurrency)}</span></div><p class="desc">${esc(item.description || '')}</p><div class="meta">${item.category ? `<span class="tag">${esc(item.category)}</span>` : ''}${item.featured ? '<span class="tag featured">Guest favourite</span>' : ''}</div></div></article>`).join('')}</div>`
      : '<div class="empty">No dishes match that search. Try another category.</div>';
  }

  function renderError(message) {
    output.innerHTML = `<div class="error"><h2>Menu unavailable</h2><p>${esc(message)}</p><p style="font-size:11px;margin-top:12px">Please ask a member of staff for today’s menu.</p></div>`;
  }

  async function load() {
    const token = new URLSearchParams(window.location.search).get('t');
    try {
      const response = await fetch(`/api/public/menu${token ? `?t=${encodeURIComponent(token)}` : ''}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `Menu request failed (${response.status})`);
      window.__menuCurrency = body.settings?.currency || 'ETB';
      document.title = `${body.settings?.restaurantName || 'Menu'} · Menu`;
      document.getElementById('restaurantName').textContent = body.settings?.restaurantName || 'Today’s menu';
      document.getElementById('menuFooter').textContent = body.settings?.receiptFooter || 'Thank you for dining with us.';
      if (body.table) {
        const badge = document.getElementById('tableBadge');
        badge.style.display = 'inline-flex';
        badge.textContent = `Table ${body.table.number}${body.table.name ? ` · ${body.table.name}` : ''}`;
      }
      state.items = body.items || [];
      state.categories = body.categories || [];
      renderCats();
      renderItems();
    } catch (error) {
      renderError(error.message);
    }
  }

  searchEl.addEventListener('input', () => {
    state.query = searchEl.value;
    renderItems();
  });

  load();
})();
