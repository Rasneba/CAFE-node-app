(() => {
  const view = document.getElementById('adminView');
  const toastEl = document.getElementById('adminToast');
  const state = { tab: 'dashboard', menu: { categories: [], items: [] }, selectedCategory: 'All items', editingId: null, summary: null, orders: [], settings: null, qrText: '' };

  function icon(name) {
    return `<i data-lucide="${name}"></i>`;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function money(value, currency) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0)} ${esc(currency || state.settings?.currency || 'ETB')}`;
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(window.__adminToast);
    window.__adminToast = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  window.showToast = toast;

  function drawIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
    return body;
  }

  function pillClass(status) {
    if (['PAID', 'READY', 'COMPLETED', 'SERVED', 'PRINTED'].includes(status)) return 'green';
    if (['SUBMITTED', 'PREPARING', 'PARTIALLY_PAID'].includes(status)) return 'orange';
    if (['CANCELLED', 'FAILED'].includes(status)) return 'red';
    return 'gray';
  }

  function statusLabel(status) {
    return String(status || '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function timeOf(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleString();
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#adminTabs [data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    render();
  }

  async function render() {
    if (state.tab === 'dashboard') return renderDashboard();
    if (state.tab === 'menu') return renderMenu();
    if (state.tab === 'orders') return renderOrders();
    if (state.tab === 'reports') return renderReports();
    if (state.tab === 'sync') return renderSync();
    if (state.tab === 'settings') return renderSettings();
    return renderDashboard();
  }

  async function renderDashboard() {
    view.innerHTML = '<div class="empty">Loading overview…</div>';
    try {
      const [summary, orders] = await Promise.all([api('/api/admin/summary'), api('/api/admin/orders?limit=8')]);
      state.summary = summary;
      state.orders = orders.orders;
      view.innerHTML = `<div class="stat-row"><div class="stat-box"><span>PAID SALES</span><b>${money(summary.sales)}</b><small>${summary.paidOrders} paid orders</small></div><div class="stat-box"><span>TOTAL ORDERS</span><b>${summary.orders}</b><small>${summary.lastOrderAt ? `Last ${timeOf(summary.lastOrderAt)}` : 'No orders yet'}</small></div><div class="stat-box"><span>MENU ITEMS</span><b>${summary.menuItems}</b><small>Live on the public menu</small></div><div class="stat-box"><span>TABLES</span><b>${summary.tables}</b><small>QR menu tokens</small></div></div>
        <div class="admin-card"><h2>Recent synced orders</h2><p class="sub">Orders pushed from the restaurant device every three minutes.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>ORDER</th><th>TABLE</th><th>ITEMS</th><th>TOTAL</th><th>STATUS</th><th>DEVICE</th><th>CREATED</th></tr></thead><tbody>${orders.orders.map((order) => `<tr><td><b>${esc(order.orderNumber)}</b></td><td>${order.tableNumber ? esc(order.tableNumber) : statusLabel(order.type)}</td><td>${order.items.length}</td><td>${money(order.total)}</td><td><span class="pill ${pillClass(order.status)}">${statusLabel(order.status)}</span></td><td>${esc(order.deviceId || '—')}</td><td>${timeOf(order.createdAt)}</td></tr>`).join('') || '<tr><td colspan="7"><div class="empty">No orders synced yet.</div></td></tr>'}</tbody></table></div></div>`;
      drawIcons();
    } catch (error) {
      view.innerHTML = `<div class="admin-card"><h2>Could not load the overview</h2><p class="sub">${esc(error.message)}</p></div>`;
    }
  }

  async function renderMenu() {
    view.innerHTML = '<div class="empty">Loading menu…</div>';
    try {
      state.menu = await api('/api/admin/menu');
      const categories = ['All items', ...state.menu.categories.map((category) => category.name)];
      const items = state.menu.items.filter((item) => state.selectedCategory === 'All items' || item.category === state.selectedCategory);
      const editing = state.editingId ? state.menu.items.find((item) => item.id === state.editingId) : null;
      view.innerHTML = `<div class="admin-grid"><div class="admin-card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><h2>Menu catalog</h2><p class="sub">${state.menu.items.length} items · ${state.menu.categories.length} categories</p></div><button class="icon-btn" onclick="adminAddCategory()" title="Add category">${icon('folder-plus')}</button></div><div class="admin-actions" style="margin-bottom:12px">${categories.map((name) => `<button class="pill ${state.selectedCategory === name ? 'green' : 'gray'}" style="border:0;cursor:pointer" onclick="adminSelectCategory('${esc(name)}')">${esc(name)}</button>`).join('')}</div><div class="admin-list">${items.map((item) => `<div class="admin-item"><img src="${esc(item.image || '')}" alt=""><div class="grow"><b>${esc(item.name)}</b><small>${esc(item.category)} · ${esc(item.station)} · ${item.available ? 'Available' : 'Sold out'}</small></div><span class="price">${money(item.price)}</span><button class="icon-btn" onclick="adminEditItem(${item.id})" title="Edit">${icon('pencil')}</button><button class="icon-btn" onclick="adminDeleteItem(${item.id})" title="Delete">${icon('trash-2')}</button></div>`).join('') || '<div class="empty">No items in this category.</div>'}</div></div>
        <div class="admin-card"><h2>${editing ? 'Edit product' : 'Add product'}</h2><p class="sub">Changes appear on the public menu immediately.</p>
          <div class="field"><label>Product name</label><input id="adminName" value="${esc(editing?.name || '')}" placeholder="Doro wat & injera"></div>
          <div class="field"><label>Price · ${esc(state.settings?.currency || 'ETB')}</label><input id="adminPrice" type="number" value="${editing ? editing.price : ''}" placeholder="420"></div>
          <div class="field"><label>Category</label><select id="adminCategory">${state.menu.categories.map((category) => `<option value="${category.id}" ${editing && editing.categoryId === category.id ? 'selected' : ''}>${esc(category.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Description</label><textarea id="adminDesc" placeholder="Ingredients and something special…">${esc(editing?.desc || '')}</textarea></div>
          <div class="field"><label>Image URL</label><input id="adminImage" value="${esc(editing?.image || '')}" placeholder="https://…"></div>
          <div class="field"><label>Station</label><select id="adminStation"><option ${editing?.station === 'Kitchen' ? 'selected' : ''}>Kitchen</option><option ${editing?.station === 'Bar' ? 'selected' : ''}>Bar</option><option ${editing?.station === 'Pastry' ? 'selected' : ''}>Pastry</option></select></div>
          <div class="field"><label>Availability</label><select id="adminAvailable"><option value="1" ${!editing || editing.available ? 'selected' : ''}>Available</option><option value="0" ${editing && !editing.available ? 'selected' : ''}>Sold out</option></select></div>
          <div class="admin-actions"><button class="btn btn-primary" onclick="adminSaveItem()">${icon('check')} Save product</button><button class="btn btn-outline" onclick="adminResetForm()">Reset</button></div>
        </div></div>`;
      drawIcons();
    } catch (error) {
      view.innerHTML = `<div class="admin-card"><h2>Could not load the menu</h2><p class="sub">${esc(error.message)}</p></div>`;
    }
  }

  async function renderOrders() {
    view.innerHTML = '<div class="empty">Loading orders…</div>';
    try {
      const body = await api('/api/admin/orders?limit=120');
      state.orders = body.orders;
      view.innerHTML = `<div class="admin-card"><h2>Synced orders</h2><p class="sub">Every paid and open check received from the restaurant device.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>ORDER</th><th>TABLE</th><th>ITEMS</th><th>SUBTOTAL</th><th>TAX</th><th>SERVICE</th><th>TOTAL</th><th>PAID</th><th>STATUS</th><th>DEVICE</th><th>CREATED</th></tr></thead><tbody>${state.orders.map((order) => `<tr><td><b>${esc(order.orderNumber)}</b></td><td>${order.tableNumber ? esc(order.tableNumber) : statusLabel(order.type)}</td><td>${order.items.map((item) => `${item.quantity} × ${esc(item.name)}`).join('<br>') || '—'}</td><td>${money(order.subtotal)}</td><td>${money(order.taxTotal)}</td><td>${money(order.serviceTotal)}</td><td><b>${money(order.total)}</b></td><td>${money(order.paidTotal)}</td><td><span class="pill ${pillClass(order.status)}">${statusLabel(order.status)}</span></td><td>${esc(order.deviceId || '—')}</td><td>${timeOf(order.createdAt)}</td></tr>`).join('') || '<tr><td colspan="11"><div class="empty">No orders synced yet.</div></td></tr>'}</tbody></table></div></div>`;
      drawIcons();
    } catch (error) {
      view.innerHTML = `<div class="admin-card"><h2>Could not load orders</h2><p class="sub">${esc(error.message)}</p></div>`;
    }
  }

  function renderReports() {
    view.innerHTML = '<div id="adminReportHost"></div>';
    document.getElementById('adminReportHost').innerHTML = window.RestaurantReports.render();
    drawIcons();
  }

  async function renderSync() {
    view.innerHTML = '<div class="empty">Loading sync status…</div>';
    try {
      const summary = await api('/api/admin/summary');
      state.summary = summary;
      const origin = window.location.origin;
      state.qrText = state.qrText || `${origin}/menu`;
      view.innerHTML = `<div class="admin-grid"><div class="admin-card"><h2>Device sync</h2><p class="sub">The restaurant device pushes every three minutes. These are the latest records received.</p><div class="stat-row" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="stat-box"><span>ORDERS</span><b>${summary.orders}</b><small>${summary.paidOrders} paid</small></div><div class="stat-box"><span>LAST ORDER</span><b style="font-size:14px">${timeOf(summary.lastOrderAt)}</b><small>Most recent sync</small></div><div class="stat-box"><span>PAID SALES</span><b style="font-size:16px">${money(summary.sales)}</b><small>From synced orders</small></div></div><div class="admin-card" style="padding:14px;background:#f8f9f5"><h2 style="font-size:13px">How sync works</h2><p class="sub" style="margin:0;line-height:1.7">The local device calls <code>/api/sync/push</code> with new orders, then <code>/api/sync/pull</code> to refresh the menu. Both endpoints require the shared <code>DEVICE_API_KEY</code>.</p></div></div>
        <div class="admin-card"><h2>Public menu QR</h2><p class="sub">Print this for tables. Add a table token with <code>?t=…</code> if needed.</p><div style="text-align:center;background:#fafbf8;border:1px solid #eceee7;border-radius:12px;padding:14px"><img id="adminQr" src="/api/admin/qr?text=${encodeURIComponent(state.qrText)}" alt="Public menu QR code" style="width:100%;max-width:260px;display:block;margin:0 auto"></div><div class="field" style="margin-top:12px"><label>Menu URL</label><input id="adminQrText" value="${esc(state.qrText)}"></div><div class="admin-actions"><button class="btn btn-primary" onclick="adminRefreshQr()">${icon('qr-code')} Refresh QR</button><a class="btn btn-outline" href="/menu" target="_blank">${icon('external-link')} Open menu</a></div></div></div>`;
      drawIcons();
    } catch (error) {
      view.innerHTML = `<div class="admin-card"><h2>Could not load sync status</h2><p class="sub">${esc(error.message)}</p></div>`;
    }
  }

  async function renderSettings() {
    view.innerHTML = '<div class="empty">Loading settings…</div>';
    try {
      const body = await api('/api/admin/settings');
      state.settings = body.settings;
      view.innerHTML = `<div class="admin-grid"><div class="admin-card"><h2>Restaurant settings</h2><p class="sub">These values flow to the local device on the next sync.</p><div class="field"><label>Restaurant name</label><input id="setName" value="${esc(body.settings.restaurantName)}"></div><div class="field"><label>Currency</label><input id="setCurrency" value="${esc(body.settings.currency)}"></div><div class="field"><label>Tax rate · %</label><input id="setTax" type="number" value="${body.settings.taxRate}"></div><div class="field"><label>Service charge · %</label><input id="setService" type="number" value="${body.settings.serviceChargeRate}"></div><div class="field"><label>Receipt footer</label><textarea id="setFooter">${esc(body.settings.receiptFooter || '')}</textarea></div><div class="admin-actions"><button class="btn btn-primary" onclick="adminSaveSettings()">${icon('check')} Save settings</button></div></div><div class="admin-card"><h2>Security</h2><p class="sub">Admin pages use HTTP Basic auth.</p><p style="font-size:11px;line-height:1.7;color:#777c72">Set <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> in Vercel. Set <code>DEVICE_API_KEY</code> to the same value on the local device so it can push orders.</p></div></div>`;
      drawIcons();
    } catch (error) {
      view.innerHTML = `<div class="admin-card"><h2>Could not load settings</h2><p class="sub">${esc(error.message)}</p></div>`;
    }
  }

  function adminSelectCategory(category) {
    state.selectedCategory = category;
    renderMenu();
  }

  function adminResetForm() {
    state.editingId = null;
    renderMenu();
  }

  function adminEditItem(id) {
    state.editingId = Number(id);
    renderMenu();
  }

  async function adminSaveItem() {
    const body = {
      id: state.editingId || undefined,
      name: document.getElementById('adminName').value.trim(),
      price: Number(document.getElementById('adminPrice').value),
      categoryId: Number(document.getElementById('adminCategory').value),
      description: document.getElementById('adminDesc').value.trim(),
      image: document.getElementById('adminImage').value.trim(),
      station: document.getElementById('adminStation').value,
      available: document.getElementById('adminAvailable').value === '1',
    };
    if (!body.name || !body.price) return toast('Name and price are required');
    try {
      await api('/api/admin/menu/items', { method: 'POST', body: JSON.stringify(body) });
      toast('Product saved');
      state.editingId = null;
      await renderMenu();
    } catch (error) {
      toast(error.message);
    }
  }

  async function adminDeleteItem(id) {
    if (!confirm('Remove this product from the public menu?')) return;
    try {
      await api(`/api/admin/menu/items/${id}`, { method: 'DELETE' });
      toast('Product removed');
      await renderMenu();
    } catch (error) {
      toast(error.message);
    }
  }

  async function adminAddCategory() {
    const name = prompt('New category name:');
    if (!name) return;
    try {
      await api('/api/admin/menu/categories', { method: 'POST', body: JSON.stringify({ name }) });
      toast('Category added');
      await renderMenu();
    } catch (error) {
      toast(error.message);
    }
  }

  function adminRefreshQr() {
    const input = document.getElementById('adminQrText');
    state.qrText = input.value.trim() || `${window.location.origin}/menu`;
    document.getElementById('adminQr').src = `/api/admin/qr?text=${encodeURIComponent(state.qrText)}`;
  }

  async function adminSaveSettings() {
    try {
      await api('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          restaurantName: document.getElementById('setName').value.trim(),
          currency: document.getElementById('setCurrency').value.trim(),
          taxRate: Number(document.getElementById('setTax').value),
          serviceChargeRate: Number(document.getElementById('setService').value),
          receiptFooter: document.getElementById('setFooter').value.trim(),
        }),
      });
      toast('Settings saved');
      await renderSettings();
    } catch (error) {
      toast(error.message);
    }
  }

  window.adminSelectCategory = adminSelectCategory;
  window.adminResetForm = adminResetForm;
  window.adminEditItem = adminEditItem;
  window.adminSaveItem = adminSaveItem;
  window.adminDeleteItem = adminDeleteItem;
  window.adminAddCategory = adminAddCategory;
  window.adminRefreshQr = adminRefreshQr;
  window.adminSaveSettings = adminSaveSettings;

  document.getElementById('adminTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) setTab(button.dataset.tab);
  });

  api('/api/admin/settings').then((body) => { state.settings = body.settings; }).catch(() => {});
  render();
})();
