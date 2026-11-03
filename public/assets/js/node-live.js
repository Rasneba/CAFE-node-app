(() => {
  const state = {
    settings: { restaurantName: 'Maison Addis', currency: 'ETB', taxRate: 15, serviceChargeRate: 10, serviceChargeEnabled: true, taxEnabled: true },
    items: [],
    categories: [],
    tables: [],
    orders: [],
    kitchen: [],
    stats: { orders: 0, sales: 0, average: 0, openOrders: 0 },
    printJobs: [],
    printer: null,
    sync: null,
    publicUrl: '',
    cart: [],
    current: 'pos',
    category: 'All items',
    menuCategory: 'All items',
    posQuery: '',
    menuQuery: '',
    orderType: 'Dine in',
    selectedTable: null,
    checkoutOrderId: null,
    paymentMethod: 'CASH',
    loaded: false,
  };

  const NAV = [
    { group: 'SERVICE', items: [['dashboard', 'Overview', 'layout-dashboard'], ['pos', 'Point of sale', 'panels-top'], ['floor', 'Tables & floor', 'layout-grid'], ['kitchen', 'Kitchen display', 'chef-hat'], ['bar', 'Bar display', 'wine']] },
    { group: 'CATALOG & SETTLEMENT', items: [['menu', 'Food & drinks', 'book-open'], ['checkout', 'Checkout & invoices', 'receipt-text'], ['printers', 'Printers', 'printer']] },
    { group: 'INSIGHTS', items: [['reports', 'Restaurant reports', 'chart-no-axes-column-increasing']] },
  ];

  const view = document.getElementById('view');

  function icon(name, cls = '') {
    return `<i data-lucide="${name}" class="${cls}"></i>`;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function money(value) {
    const currency = state.settings.currency || 'ETB';
    return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value) || 0)} ${currency}`;
  }

  function drawIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function toast(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
    return body;
  }

  function pillClass(status) {
    if (['PAID', 'READY', 'COMPLETED', 'SERVED', 'PRINTED', 'ok'].includes(status)) return 'green';
    if (['SUBMITTED', 'PREPARING', 'QUEUED', 'PARTIALLY_PAID'].includes(status)) return 'orange';
    if (['CANCELLED', 'FAILED', 'error'].includes(status)) return 'red';
    return 'gray';
  }

  function statusLabel(status) {
    return String(status || '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function timeOf(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function pageHeading(title, subtitle, actions = '') {
    const eyebrow = ({
      pos: 'FRONT OF HOUSE · LIVE SERVICE',
      kitchen: 'PASS · LIVE SERVICE',
      bar: 'BEVERAGE STATION · LIVE SERVICE',
      menu: 'CATALOG · LIVE DATA',
      printers: 'SETUP · LOCAL DEVICE',
      checkout: 'CASHIER · OPEN CHECKS',
      dashboard: 'TODAY · LIVE SERVICE',
      floor: 'DINING ROOM · LIVE SERVICE',
      reports: 'REPORTS · RESTAURANT SALES',
    })[state.current] || 'MAISON ADDIS · LIVE SERVICE';
    return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
  }

  function renderNav() {
    const counts = {
      kitchen: state.kitchen.filter((order) => order.items.some((item) => item.station !== 'Bar')).length,
      bar: state.kitchen.filter((order) => order.items.some((item) => item.station === 'Bar')).length,
    };
    document.getElementById('navGroups').innerHTML = NAV.map((group) => (
      `<div class="nav-caption">${group.group}</div>${group.items.map(([id, label, ico]) => {
        const count = counts[id] || 0;
        return `<a class="nav-item ${state.current === id ? 'active' : ''}" href="#${id}" data-page="${id}">${icon(ico)}<span>${label}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</a>`;
      }).join('')}`
    )).join('');
  }

  function renderCurrent() {
    if (!state.loaded) return `<div class="surface" style="padding:40px;text-align:center">${icon('loader-circle')} Loading live restaurant data…</div>`;
    const pages = {
      pos: posPage,
      kitchen: () => kdsPage(false),
      bar: () => kdsPage(true),
      menu: menuPage,
      checkout: checkoutPage,
      printers: printerPage,
      dashboard: dashboardPage,
      floor: floorPage,
      reports: () => (typeof window.reportPage === 'function' ? window.reportPage() : ''),
    };
    return (pages[state.current] || posPage)();
  }

  function navPage(id) {
    state.current = id;
    state.category = 'All items';
    state.menuCategory = 'All items';
    renderNav();
    const label = NAV.flatMap((group) => group.items).find((item) => item[0] === id)?.[1] || id;
    document.getElementById('crumbLabel').textContent = label;
    view.innerHTML = renderCurrent();
    drawIcons();
    bindPage();
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('mobileScrim').classList.remove('open');
    window.scrollTo(0, 0);
  }

  function rerender() {
    view.innerHTML = renderCurrent();
    drawIcons();
    bindPage();
  }

  function bindPage() {
    const posSearch = document.getElementById('posSearch');
    if (posSearch) posSearch.oninput = () => { state.posQuery = posSearch.value; refreshPosProducts(); };
    const menuSearch = document.getElementById('menuSearch');
    if (menuSearch) menuSearch.oninput = () => { state.menuQuery = menuSearch.value; refreshMenuCards(); };
  }

  function filteredPosItems() {
    const query = state.posQuery.trim().toLowerCase();
    return state.items.filter((item) => (state.category === 'All items' || item.category === state.category) && (!query || item.name.toLowerCase().includes(query)));
  }

  function refreshPosProducts() {
    const grid = document.getElementById('posProducts');
    if (!grid) return;
    grid.innerHTML = filteredPosItems().map((item) => productCard(item)).join('') || '<div class="cart-empty">No dishes match your search.</div>';
    drawIcons();
  }

  function productCard(item) {
    return `<article class="product-card" onclick="addProduct(${item.id})"><div class="product-image"><img src="${esc(item.image || '')}" alt="${esc(item.name)}" loading="lazy"><span class="availability" style="${item.available ? '' : 'color:#ad5147'}"><i class="dot" style="${item.available ? '' : 'background:#bd584e'}"></i>${item.available ? 'Available' : 'Sold out'}</span></div><div class="product-card-body"><div class="product-name">${esc(item.name)}</div><div class="product-meta">${esc(item.category)} · ${esc(item.station)}</div><div class="product-card-bottom"><span class="product-price">${money(item.price)}</span><button class="add-circle" aria-label="Add ${esc(item.name)}">${icon('plus')}</button></div></div></article>`;
  }

  function cartTotals() {
    const subtotal = state.cart.reduce((sum, line) => sum + line.price * line.qty, 0);
    const tax = state.settings.taxEnabled ? subtotal * Number(state.settings.taxRate) / 100 : 0;
    const service = state.settings.serviceChargeEnabled ? subtotal * Number(state.settings.serviceChargeRate) / 100 : 0;
    return { subtotal, tax, service, total: subtotal + tax + service };
  }

  function refreshCart() {
    const lines = document.getElementById('cartLines');
    if (!lines) return;
    lines.innerHTML = state.cart.length ? state.cart.map((line) => `<div class="cart-line"><div class="cart-line-main"><div class="cart-line-name">${esc(line.name)}</div><button class="cart-line-note" onclick="editItemNote(${line.id})">${esc(line.note || '+ Add modifiers or note')}</button></div><div class="quantity"><button onclick="changeQty(${line.id},-1)" aria-label="Remove one">${icon('minus')}</button><b>${line.qty}</b><button onclick="changeQty(${line.id},1)" aria-label="Add one">${icon('plus')}</button></div><div class="line-price">${money(line.price * line.qty)}</div></div>`).join('') : `<div class="cart-empty">${icon('shopping-basket')}Your order is ready for something lovely.<br>Choose a dish to begin.</div>`;
    const totals = cartTotals();
    document.getElementById('subtotal').textContent = money(totals.subtotal);
    document.getElementById('vat').textContent = money(totals.tax);
    const serviceEl = document.getElementById('service');
    if (serviceEl) serviceEl.textContent = money(totals.service);
    document.getElementById('total').textContent = money(totals.total);
    drawIcons();
  }

  function addProduct(id) {
    const item = state.items.find((entry) => entry.id === Number(id));
    if (!item || !item.available) return toast('This dish is marked sold out');
    const line = state.cart.find((entry) => entry.id === item.id);
    if (line) line.qty += 1;
    else state.cart.push({ id: item.id, name: item.name, price: item.price, qty: 1, note: '' });
    refreshCart();
    toast(`${item.name} added to order`);
  }

  function changeQty(id, delta) {
    const line = state.cart.find((entry) => entry.id === Number(id));
    if (!line) return;
    line.qty += delta;
    if (line.qty < 1) state.cart = state.cart.filter((entry) => entry.id !== line.id);
    refreshCart();
  }

  function editItemNote(id) {
    const line = state.cart.find((entry) => entry.id === Number(id));
    if (!line) return;
    const note = prompt('Special instructions:', line.note || '');
    if (note !== null) {
      line.note = note.trim();
      refreshCart();
    }
  }

  function clearCart() {
    state.cart = [];
    refreshCart();
    toast('Order cleared');
  }

  function setCategory(category) {
    state.category = category;
    view.querySelectorAll('[data-category]').forEach((button) => button.classList.toggle('active', button.dataset.category === category));
    refreshPosProducts();
  }

  function setOrderType(type) {
    state.orderType = type;
    rerender();
  }

  function setTable(value) {
    state.selectedTable = value ? Number(value) : null;
    rerender();
  }

  function selectedTableNumber() {
    return state.tables.find((table) => table.id === Number(state.selectedTable))?.number || '—';
  }

  function posPage() {
    const categories = ['All items', ...new Set(state.items.map((item) => item.category))];
    const tableOptions = state.tables.map((table) => `<option value="${table.id}" ${Number(state.selectedTable) === table.id ? 'selected' : ''}>Table ${esc(table.number)} · ${table.capacity} guests</option>`).join('');
    const totals = cartTotals();
    return `${pageHeading('Good afternoon', 'Every order here goes straight to the kitchen and the printer.', `<button class="btn btn-outline" onclick="navPage('floor')">${icon('layout-grid')} Floor plan</button><button class="btn btn-primary" onclick="clearCart()">${icon('plus')} New order</button>`)}
      <div class="pos-toolbar"><label class="search-field">${icon('search')}<input id="posSearch" placeholder="Find a dish or drink…" autocomplete="off" value="${esc(state.posQuery)}"></label><select class="soft-select" aria-label="Select table" onchange="setTable(this.value)">${tableOptions}</select><div class="space"></div><div class="order-type">${['Dine in', 'Takeaway', 'Delivery'].map((type) => `<button class="${state.orderType === type ? 'active' : ''}" onclick="setOrderType('${type}')">${type}</button>`).join('')}</div></div>
      <div class="category-strip">${categories.map((category) => `<button class="category-chip ${state.category === category ? 'active' : ''}" data-category="${esc(category)}" onclick="setCategory('${esc(category)}')">${esc(category)}</button>`).join('')}</div>
      <div class="pos-layout"><div class="product-grid" id="posProducts">${filteredPosItems().map((item) => productCard(item)).join('')}</div>
        <aside class="surface cart-card"><div class="cart-top"><div><h2>Current order</h2><p>${state.orderType} · Table ${esc(selectedTableNumber())}</p></div><button class="icon-button quiet" onclick="clearCart()" aria-label="Clear order">${icon('ellipsis')}</button></div>
          <div class="cart-meta"><select aria-label="Table" onchange="setTable(this.value)">${tableOptions}</select><select aria-label="Guests"><option>2 guests</option><option>4 guests</option><option>6 guests</option></select></div>
          <div class="cart-lines" id="cartLines">${state.cart.length ? state.cart.map((line) => `<div class="cart-line"><div class="cart-line-main"><div class="cart-line-name">${esc(line.name)}</div><button class="cart-line-note" onclick="editItemNote(${line.id})">${esc(line.note || '+ Add modifiers or note')}</button></div><div class="quantity"><button onclick="changeQty(${line.id},-1)">${icon('minus')}</button><b>${line.qty}</b><button onclick="changeQty(${line.id},1)">${icon('plus')}</button></div><div class="line-price">${money(line.price * line.qty)}</div></div>`).join('') : `<div class="cart-empty">${icon('shopping-basket')}Your order is ready for something lovely.<br>Choose a dish to begin.</div>`}</div>
          <div class="cart-bottom"><div class="summary-row"><span>Subtotal</span><b id="subtotal">${money(totals.subtotal)}</b></div><div class="summary-row"><span>Tax (${state.settings.taxRate}%)</span><b id="vat">${money(totals.tax)}</b></div>${state.settings.serviceChargeEnabled ? `<div class="summary-row"><span>Service (${state.settings.serviceChargeRate}%)</span><b id="service">${money(totals.service)}</b></div>` : ''}<div class="summary-row total"><span>Total</span><b id="total">${money(totals.total)}</b></div><div class="cart-actions"><button class="btn btn-outline" onclick="clearCart()">Clear</button><button class="btn btn-primary" onclick="submitOrder()">${icon('send')} Send to kitchen</button></div></div>
        </aside></div>`;
  }

  async function submitOrder() {
    if (!state.cart.length) return toast('Add at least one item first');
    const type = state.orderType === 'Takeaway' ? 'TAKEAWAY' : state.orderType === 'Delivery' ? 'DELIVERY' : 'DINE_IN';
    if (type === 'DINE_IN' && !state.selectedTable) return toast('Choose a table first');
    try {
      const { order } = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          type,
          tableId: type === 'DINE_IN' ? Number(state.selectedTable) : null,
          guestCount: 2,
          items: state.cart.map((line) => ({ menuItemId: line.id, quantity: line.qty, notes: line.note })),
        }),
      });
      state.cart = [];
      toast(`Order ${order.orderNumber} sent to the kitchen`);
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  function menuPage() {
    const categories = ['All items', ...state.categories.map((category) => category.name)];
    const items = state.items.filter((item) => (state.menuCategory === 'All items' || item.category === state.menuCategory) && (!state.menuQuery || item.name.toLowerCase().includes(state.menuQuery.toLowerCase())));
    return `${pageHeading('Food & drinks', 'Everything here is live data. Edits sync to the cloud every three minutes.', `<button class="btn btn-outline" onclick="addCategory()">${icon('folder-plus')} Add category</button><button class="btn btn-primary" onclick="openProductModal()">${icon('plus')} Add product</button>`)}
      <div class="filter-row"><label class="search-field">${icon('search')}<input id="menuSearch" placeholder="Search products…" value="${esc(state.menuQuery)}"></label><select class="soft-select" id="stationFilter"><option>All stations</option><option>Kitchen</option><option>Bar</option></select><div class="space"></div><span class="section-label">${items.length} items</span></div>
      <div class="category-strip menu-filters">${categories.map((category) => `<button class="category-chip ${state.menuCategory === category ? 'active' : ''}" onclick="setMenuCategory('${esc(category)}')">${esc(category)}</button>`).join('')}</div>
      <div class="four-col" id="menuGrid">${items.map((item) => menuCard(item)).join('')}</div>`;
  }

  function menuCard(item) {
    return `<article class="surface catalog-card"><div class="menu-card-image"><img src="${esc(item.image || '')}" alt="${esc(item.name)}" loading="lazy"><span class="pill ${item.available ? 'green' : 'gray'}">${item.available ? 'Available' : 'Sold out'}</span></div><div class="catalog-info"><div class="catalog-title"><b>${esc(item.name)}</b><span class="pill gray">${esc(item.station)}</span></div><p>${esc(item.desc)}</p><div class="catalog-foot"><strong>${money(item.price)}</strong><div class="catalog-actions"><button aria-label="Edit product" onclick="openProductModal(${item.id})">${icon('pencil')}</button><button aria-label="Delete product" onclick="deleteProduct(${item.id})">${icon('trash-2')}</button></div></div></div></article>`;
  }

  function setMenuCategory(category) {
    state.menuCategory = category;
    rerender();
  }

  function refreshMenuCards() {
    const grid = document.getElementById('menuGrid');
    if (!grid) return;
    const items = state.items.filter((item) => (state.menuCategory === 'All items' || item.category === state.menuCategory) && (!state.menuQuery || item.name.toLowerCase().includes(state.menuQuery.toLowerCase())));
    grid.innerHTML = items.map((item) => menuCard(item)).join('');
    drawIcons();
  }

  function openProductModal(id) {
    const item = id ? state.items.find((entry) => entry.id === Number(id)) : null;
    const layer = document.getElementById('modalLayer');
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
    layer.innerHTML = `<div class="modal-box"><div class="modal-head"><div><div class="eyebrow">CATALOG · PRODUCT DETAILS</div><h2>${item ? 'Edit product' : 'Add a product'}</h2></div><button class="icon-button" onclick="closeLiveModal()" aria-label="Close">${icon('x')}</button></div>
      <div class="modal-content"><div class="upload-preview"><div class="upload-zone"><div class="upload-content">${icon('image-plus')}<b>Product photo URL</b><small>Paste an image URL below</small></div></div><div>
        <div class="field"><label class="form-label">Product name</label><input class="form-control" id="liveProductName" value="${esc(item?.name || '')}" placeholder="e.g. Wild mushroom tagliatelle"></div>
        <div class="form-grid"><div class="field"><label class="form-label">Price · ${esc(state.settings.currency)}</label><input type="number" class="form-control" id="liveProductPrice" value="${item ? item.price : ''}" placeholder="385"></div><div class="field"><label class="form-label">Category</label><select class="form-control" id="liveProductCategory">${state.categories.map((category) => `<option value="${category.id}" ${item && item.categoryId === category.id ? 'selected' : ''}>${esc(category.name)}</option>`).join('')}</select></div></div>
        <div class="field"><label class="form-label">Description</label><textarea class="form-control form-area" id="liveProductDesc" placeholder="Ingredients and something special about it…">${esc(item?.desc || '')}</textarea></div>
        <div class="form-grid"><div class="field"><label class="form-label">Preparation station</label><select class="form-control" id="liveProductStation"><option ${item?.station === 'Kitchen' ? 'selected' : ''}>Kitchen</option><option ${item?.station === 'Bar' ? 'selected' : ''}>Bar</option><option ${item?.station === 'Pastry' ? 'selected' : ''}>Pastry</option></select></div><div class="field"><label class="form-label">Image URL</label><input class="form-control" id="liveProductImage" value="${esc(item?.image || '')}" placeholder="https://…"></div></div>
        <div class="toggle-row"><span><b>Available to order</b><small>Visible on the POS and public menu</small></span><label class="switch"><input type="checkbox" id="liveProductAvailable" ${!item || item.available ? 'checked' : ''}></label></div>
      </div></div></div>
      <div class="modal-foot"><button class="btn btn-outline" onclick="closeLiveModal()">Cancel</button><button class="btn btn-primary" onclick="saveProduct(${item ? item.id : 'null'})">${icon('check')} Save product</button></div></div>`;
    drawIcons();
  }

  function closeLiveModal() {
    const layer = document.getElementById('modalLayer');
    layer.classList.remove('open');
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '';
  }

  async function saveProduct(id) {
    const name = document.getElementById('liveProductName').value.trim();
    const price = Number(document.getElementById('liveProductPrice').value);
    if (!name || !price) return toast('Name and price are required');
    try {
      await api('/api/admin/menu/items', {
        method: 'POST',
        body: JSON.stringify({
          id: id || undefined,
          name,
          price,
          categoryId: Number(document.getElementById('liveProductCategory').value),
          description: document.getElementById('liveProductDesc').value.trim(),
          station: document.getElementById('liveProductStation').value,
          image: document.getElementById('liveProductImage').value.trim(),
          available: document.getElementById('liveProductAvailable').checked,
        }),
      });
      closeLiveModal();
      toast('Product saved');
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  async function deleteProduct(id) {
    if (!confirm('Remove this product from the menu?')) return;
    try {
      await api(`/api/admin/menu/items/${id}`, { method: 'DELETE' });
      toast('Product removed');
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  async function addCategory() {
    const name = prompt('New category name:');
    if (!name) return;
    try {
      await api('/api/admin/menu/categories', { method: 'POST', body: JSON.stringify({ name }) });
      toast('Category added');
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  function kdsPage(isBar) {
    const mode = isBar ? 'bar-mode' : '';
    const orders = state.kitchen
      .map((order) => ({ ...order, items: order.items.filter((item) => (isBar ? item.station === 'Bar' : item.station !== 'Bar')) }))
      .filter((order) => order.items.length);
    const columns = [
      ['PENDING', 'New orders'],
      ['PREPARING', 'Preparing'],
      ['READY', 'Ready to serve'],
    ];
    const title = isBar ? 'Bar display' : 'Kitchen display';
    return `<div class="kds-mode ${mode}"><div class="kds-top"><div><div class="eyebrow">${isBar ? 'BEVERAGE STATION' : 'KITCHEN PASS'} · LIVE SERVICE</div><h1 class="display-title">${title}</h1><p style="font-size:10px;color:#a6aea4;margin:6px 0 0">Tickets update from real orders. The printer queue runs every three seconds.</p></div><div class="kds-stats"><span class="kds-stat"><b>${orders.length}</b> tickets</span><span class="kds-stat"><b>${orders.reduce((sum, order) => sum + order.items.length, 0)}</b> items</span><span class="kds-stat"><b>${state.sync?.configured ? 'ON' : 'OFF'}</b> sync</span></div></div>
      <div class="ticket-columns">${columns.map(([status, label]) => {
        const tickets = orders.filter((order) => order.items.some((item) => item.status === status));
        return `<div class="ticket-column"><div class="ticket-column-head"><b>${label}</b><span class="count">${tickets.length}</span></div><div class="ticket-stack">${tickets.map((order) => kdsTicket(order, status)).join('') || '<div class="ticket-empty">Nothing here right now</div>'}</div></div>`;
      }).join('')}</div></div>`;
  }

  function kdsTicket(order, status) {
    const items = order.items.filter((item) => item.status === status);
    return `<article class="ticket"><div class="ticket-head"><div><div class="ticket-num">${esc(order.orderNumber)}</div><div class="ticket-meta">${order.tableNumber ? `Table ${esc(order.tableNumber)}` : statusLabel(order.type)} · ${esc(timeOf(order.createdAt))}</div></div><span class="ticket-timer">${order.items.length} items</span></div><div class="ticket-items">${items.map((item) => `<div class="ticket-item"><span class="ticket-qty">${item.quantity}</span><div style="flex:1"><b>${esc(item.name)}</b>${item.notes ? `<small>${esc(item.notes)}</small>` : ''}<div class="station-actions"><button class="btn btn-outline btn-small" onclick="setItemStatus('${item.uuid}','PREPARING')">Start</button><button class="btn btn-primary btn-small" onclick="setItemStatus('${item.uuid}','READY')">Ready</button><button class="btn btn-outline btn-small" onclick="setItemStatus('${item.uuid}','SERVED')">Served</button></div></div></div>`).join('')}</div><div class="ticket-foot"><span class="ticket-table">${esc(order.type)}</span><span class="pill ${pillClass(status)}">${statusLabel(status)}</span></div></article>`;
  }

  async function setItemStatus(itemId, status) {
    try {
      await api(`/api/kitchen/items/${itemId}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  function checkoutPage() {
    const openOrders = state.orders.filter((order) => !['COMPLETED', 'CANCELLED'].includes(order.status));
    if (!state.checkoutOrderId && openOrders.length) state.checkoutOrderId = openOrders[0].uuid;
    const order = openOrders.find((entry) => entry.uuid === state.checkoutOrderId) || openOrders[0];
    return `${pageHeading('Checkout & invoices', 'Record a payment and print a receipt without leaving the POS.', `<button class="btn btn-outline" onclick="navPage('pos')">${icon('plus')} New order</button>`)}
      <div class="checkout-grid"><div style="display:grid;gap:14px"><div class="surface"><div class="surface-head"><div><div class="surface-title">Open checks</div><div class="surface-sub">${openOrders.length} open orders</div></div><span class="pill orange">${openOrders.length ? 'Live' : 'Clear'}</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>ORDER</th><th>TABLE</th><th>ITEMS</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>${openOrders.map((entry) => `<tr onclick="selectCheckoutOrder('${entry.uuid}')" style="cursor:pointer"><td><b>${esc(entry.orderNumber)}</b></td><td>${entry.tableNumber ? esc(entry.tableNumber) : statusLabel(entry.type)}</td><td>${entry.items.length}</td><td>${money(entry.total)}</td><td><span class="pill ${pillClass(entry.status)}">${statusLabel(entry.status)}</span></td></tr>`).join('') || '<tr><td colspan="5">No open checks.</td></tr>'}</tbody></table></div></div>
        ${order ? `<div class="surface"><div class="surface-head"><div><div class="surface-title">Order ${esc(order.orderNumber)}</div><div class="surface-sub">${order.tableNumber ? `Table ${esc(order.tableNumber)}` : statusLabel(order.type)} · ${esc(timeOf(order.createdAt))}</div></div><span class="pill ${pillClass(order.status)}">${statusLabel(order.status)}</span></div><div class="checkout-items">${order.items.map((item) => `<div class="checkout-item"><div><b>${esc(item.name)}</b><small>${item.quantity} × ${money(item.unitPrice)}</small></div><strong>${money(item.lineTotal)}</strong></div>`).join('')}</div></div>` : ''}</div>
      <div style="display:grid;gap:14px">${order ? `<div class="surface"><div class="surface-head"><div><div class="surface-title">Choose payment method</div><div class="surface-sub">Cash, card or mobile money</div></div></div><div style="padding:0 17px 17px"><div class="payment-choice">${[['banknote', 'Cash', 'CASH'], ['credit-card', 'Card', 'CARD'], ['smartphone', 'Mobile', 'TELEBIRR']].map(([ico, label, code]) => `<button class="payment-option ${state.paymentMethod === code ? 'selected' : ''}" onclick="setPaymentMethod('${code}')">${icon(ico)}${label}</button>`).join('')}</div><div class="field" style="margin-top:14px"><label class="form-label">Amount received</label><input class="form-control" id="paymentAmount" value="${Number(order.total) - Number(order.paidTotal)}"></div><button class="btn btn-primary btn-block" style="margin-top:14px" onclick="recordPayment()">${icon('check')} Record payment</button><button class="btn btn-outline btn-block" style="margin-top:7px" onclick="printReceiptTest()">${icon('printer')} Test printer</button></div></div>
        <div class="surface"><div class="surface-head"><div><div class="surface-title">Order total</div><div class="surface-sub">${esc(state.settings.restaurantName)}</div></div><span class="pill orange">${money(Number(order.total) - Number(order.paidTotal))} due</span></div><div style="padding:0 17px 17px"><div class="summary-row"><span>Subtotal</span><b>${money(order.subtotal)}</b></div><div class="summary-row"><span>Tax</span><b>${money(order.taxTotal)}</b></div><div class="summary-row"><span>Service</span><b>${money(order.serviceTotal)}</b></div><div class="summary-row total"><span>Total</span><b>${money(order.total)}</b></div><div class="summary-row"><span>Paid</span><b>${money(order.paidTotal)}</b></div></div></div>` : '<div class="surface" style="padding:30px;text-align:center">No open checks.</div>'}</div></div>`;
  }

  function selectCheckoutOrder(syncId) {
    state.checkoutOrderId = syncId;
    rerender();
  }

  function setPaymentMethod(code) {
    state.paymentMethod = code;
    rerender();
  }

  async function recordPayment() {
    const order = state.orders.find((entry) => entry.uuid === state.checkoutOrderId);
    if (!order) return toast('Choose an open check');
    const amount = Number(document.getElementById('paymentAmount')?.value || 0);
    try {
      await api(`/api/orders/${order.uuid}/pay`, { method: 'POST', body: JSON.stringify({ methodCode: state.paymentMethod, amount, tendered: amount }) });
      toast('Payment recorded and receipt queued');
      state.checkoutOrderId = null;
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  function printerPage() {
    const printer = state.printer || {};
    return `${pageHeading('Printers', 'The local device prints kitchen tickets and receipts over TCP 9100.', `<button class="btn btn-outline" onclick="processPrintQueue()">${icon('rotate-cw')} Process queue</button><button class="btn btn-primary" onclick="testPrinter()">${icon('printer')} Test print</button>`)}
      <div class="stat-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="surface stat-card"><div class="stat-label">PRINTER</div><div class="stat-value" style="font-size:16px">${esc(printer.name || 'Not configured')}</div><div class="stat-foot">${esc(printer.ip || '—')}:${esc(printer.port || '—')}</div></div><div class="surface stat-card"><div class="stat-label">MODE</div><div class="stat-value" style="font-size:16px">${printer.dryRun ? 'Dry run' : 'Live'}</div><div class="stat-foot">${printer.dryRun ? 'Tickets saved to logs/' : 'Sending to the network printer'}</div></div><div class="surface stat-card"><div class="stat-label">PAPER WIDTH</div><div class="stat-value" style="font-size:16px">${esc(printer.paperWidth || 80)} mm</div><div class="stat-foot">${esc(printer.width || 48)} characters per line</div></div></div>
      <div class="surface"><div class="surface-head"><div><div class="surface-title">Print queue</div><div class="surface-sub">Latest tickets and receipts</div></div><span class="pill ${state.printJobs.some((job) => job.status === 'QUEUED') ? 'orange' : 'green'}">${state.printJobs.filter((job) => job.status === 'QUEUED').length} queued</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>JOB</th><th>TYPE</th><th>STATION</th><th>STATUS</th><th>CREATED</th><th>ERROR</th></tr></thead><tbody>${state.printJobs.map((job) => `<tr><td>${esc(job.job_number)}</td><td>${statusLabel(job.document_type)}</td><td>${esc(job.station || '—')}</td><td><span class="pill ${pillClass(job.status)}">${statusLabel(job.status)}</span></td><td>${esc(timeOf(job.created_at))}</td><td>${esc(job.last_error || '')}</td></tr>`).join('') || '<tr><td colspan="6">No print jobs yet.</td></tr>'}</tbody></table></div></div>`;
  }

  async function testPrinter() {
    try {
      await api('/api/print/test', { method: 'POST' });
      toast('Test ticket queued');
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  async function processPrintQueue() {
    try {
      await api('/api/print/process', { method: 'POST' });
      toast('Print queue processed');
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  function printReceiptTest() {
    testPrinter();
  }

  function dashboardPage() {
    const stats = state.stats || {};
    const openOrders = state.orders.filter((order) => !['COMPLETED', 'CANCELLED'].includes(order.status)).slice(0, 6);
    const kitchenCount = state.kitchen.filter((order) => order.items.some((item) => item.station !== 'Bar')).length;
    const barCount = state.kitchen.filter((order) => order.items.some((item) => item.station === 'Bar')).length;
    return `${pageHeading('A lovely day at the restaurant', 'Live numbers from this device and the cloud sync.', `<button class="btn btn-outline" onclick="runSyncNow()">${icon('refresh-cw')} Sync now</button><a class="btn btn-primary" href="/menu" target="_blank">${icon('qr-code')} Public menu</a>`)}
      <div class="stat-grid">${[['TODAY’S SALES', money(stats.sales), `${stats.orders || 0} orders`, 'wallet'], ['ORDERS TODAY', String(stats.orders || 0), `${stats.openOrders || 0} still open`, 'receipt-text'], ['AVERAGE CHECK', money(stats.average), 'Across paid and open orders', 'chart-no-axes-combined'], ['KITCHEN QUEUE', String(kitchenCount + barCount), `${kitchenCount} kitchen · ${barCount} bar`, 'chef-hat']].map(([label, value, foot, ico]) => `<div class="surface stat-card"><div style="display:flex;justify-content:space-between"><span class="stat-label">${label}</span><span class="activity-icon">${icon(ico)}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`).join('')}</div>
      <div class="two-col"><div class="surface"><div class="surface-head"><div><div class="surface-title">Recent orders</div><div class="surface-sub">Latest activity on this device</div></div><a class="text-link" href="#checkout" onclick="navPage('checkout');return false">Open checkout</a></div><div class="table-scroll"><table class="data-table"><thead><tr><th>ORDER</th><th>TABLE</th><th>TIME</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>${openOrders.map((order) => `<tr><td>${esc(order.orderNumber)}</td><td>${order.tableNumber ? esc(order.tableNumber) : statusLabel(order.type)}</td><td>${esc(timeOf(order.createdAt))}</td><td>${money(order.total)}</td><td><span class="pill ${pillClass(order.status)}">${statusLabel(order.status)}</span></td></tr>`).join('') || '<tr><td colspan="5">No open orders yet.</td></tr>'}</tbody></table></div></div>
        <div class="surface"><div class="surface-head"><div><div class="surface-title">Sync & printing</div><div class="surface-sub">Local device health</div></div><span class="pill ${state.sync?.configured ? 'green' : 'gray'}">${state.sync?.configured ? 'Connected' : 'Offline only'}</span></div>${[['refresh-cw', 'Last sync', state.sync?.lastSyncAt ? new Date(state.sync.lastSyncAt).toLocaleString() : 'Never'], ['printer', 'Printer', state.printer?.dryRun ? 'Dry run (logs/)' : `${state.printer?.ip}:${state.printer?.port}`], ['cloud', 'Cloud URL', state.sync?.cloudUrl || 'Not configured'], ['database', 'Database', 'Postgres / SQLite fallback']].map(([ico, label, value]) => `<div class="activity-row"><span class="activity-icon">${icon(ico)}</span><div><b>${label}</b><small>${esc(value)}</small></div></div>`).join('')}</div></div>`;
  }

  function floorPage() {
    const openByTable = new Map(state.orders.filter((order) => order.tableId && !['COMPLETED', 'CANCELLED'].includes(order.status)).map((order) => [order.tableId, order]));
    return `${pageHeading('Tables & floor', 'Tap a table to start an order for that table.', `<button class="btn btn-primary" onclick="navPage('pos')">${icon('plus')} Start order</button>`)}
      <div class="stat-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">${[['TABLES', state.tables.length, 'green'], ['OPEN', openByTable.size, 'blue'], ['FREE', Math.max(0, state.tables.length - openByTable.size), 'green'], ['ITEMS IN KITCHEN', state.kitchen.reduce((sum, order) => sum + order.items.length, 0), 'orange']].map(([label, value, tone]) => `<div class="surface stat-card" style="min-height:80px;padding:13px"><div class="stat-label">${label}</div><div class="stat-value" style="font-size:20px">${value}</div></div>`).join('')}</div>
      <div class="floor-canvas"><div class="floor-zone-head"><div><b>MAIN DINING</b><small style="display:block;margin-top:4px">${state.tables.length} tables · live status</small></div>${icon('ellipsis')}</div><div class="table-tiles">${state.tables.map((table) => {
        const order = openByTable.get(table.id);
        const tone = order ? 'occupied' : 'available';
        return `<button class="floor-table ${tone}" onclick="startTableOrder(${table.id})"><div class="floor-table-top"><b>${esc(table.number)}</b>${icon('users')}</div><div class="floor-symbol">${order ? statusLabel(order.status) : 'Available'}</div><small>${order ? `${esc(order.orderNumber)} · ${money(order.total)}` : `Seats ${table.capacity}`}</small></button>`;
      }).join('')}</div></div><div class="floor-legend">${[['Available', ''], ['Occupied', 'occupied'], ['Preparing', 'preparing'], ['Payment pending', 'payment']].map(([label, cls]) => `<span class="legend-item"><i class="legend-dot ${cls}"></i>${label}</span>`).join('')}</div>`;
  }

  function startTableOrder(tableId) {
    state.selectedTable = Number(tableId);
    state.orderType = 'Dine in';
    navPage('pos');
  }

  async function refreshAll() {
    const [bootstrap, orders, kitchen, stats, jobs] = await Promise.all([
      api('/api/bootstrap'),
      api('/api/orders?limit=60'),
      api('/api/kitchen'),
      api('/api/stats'),
      api('/api/print/jobs'),
    ]);
    state.settings = bootstrap.settings;
    state.items = bootstrap.items;
    state.categories = bootstrap.categories;
    state.tables = bootstrap.tables;
    state.printer = bootstrap.printer;
    state.sync = bootstrap.sync;
    state.publicUrl = bootstrap.publicUrl;
    if (!state.selectedTable && state.tables.length) state.selectedTable = state.tables[0].id;
    state.orders = orders.orders;
    state.kitchen = kitchen.orders;
    state.stats = stats.today;
    state.printJobs = jobs.jobs;
    state.loaded = true;
  }

  async function refreshSync() {
    try {
      state.sync = await api('/api/sync/status');
      updateSyncPill();
    } catch {
      // Keep the last known status.
    }
  }

  function installSyncPill() {
    const actions = document.querySelector('.topbar-actions');
    if (!actions || document.getElementById('syncPill')) return;
    const pill = document.createElement('button');
    pill.id = 'syncPill';
    pill.className = 'service-pill';
    pill.type = 'button';
    pill.style.border = '0';
    pill.style.cursor = 'pointer';
    pill.onclick = () => runSyncNow();
    actions.prepend(pill);
    updateSyncPill();
  }

  function updateSyncPill() {
    const pill = document.getElementById('syncPill');
    if (!pill) return;
    const sync = state.sync || {};
    let label = 'Offline only';
    if (sync.configured) {
      if (sync.lastResult === 'ok') label = `Synced ${timeOf(sync.lastSyncAt) || ''}`.trim();
      else if (sync.lastResult === 'error') label = 'Sync issue';
      else label = 'Sync ready';
    }
    pill.innerHTML = `<span class="service-live" style="${sync.configured ? '' : 'background:#b9bdb3'}"></span>${esc(label)}`;
    pill.title = sync.lastError || (sync.configured ? 'Click to sync now' : 'Set CLOUD_URL and DEVICE_API_KEY to enable sync');
  }

  async function runSyncNow() {
    toast('Syncing with the cloud…');
    try {
      const result = await api('/api/sync/run', { method: 'POST' });
      toast(result.error ? `Sync: ${result.error}` : 'Sync complete');
      await refreshSync();
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message);
    }
  }

  window.navPage = navPage;
  window.addProduct = addProduct;
  window.changeQty = changeQty;
  window.editItemNote = editItemNote;
  window.clearCart = clearCart;
  window.submitOrder = submitOrder;
  window.setCategory = setCategory;
  window.setOrderType = setOrderType;
  window.setTable = setTable;
  window.setMenuCategory = setMenuCategory;
  window.openProductModal = openProductModal;
  window.closeLiveModal = closeLiveModal;
  window.saveProduct = saveProduct;
  window.deleteProduct = deleteProduct;
  window.addCategory = addCategory;
  window.setItemStatus = setItemStatus;
  window.selectCheckoutOrder = selectCheckoutOrder;
  window.setPaymentMethod = setPaymentMethod;
  window.recordPayment = recordPayment;
  window.testPrinter = testPrinter;
  window.processPrintQueue = processPrintQueue;
  window.startTableOrder = startTableOrder;
  window.runSyncNow = runSyncNow;

  document.addEventListener('click', (event) => {
    if (event.target.id === 'modalLayer') closeLiveModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLiveModal();
  });

  (async function boot() {
    try {
      await refreshAll();
    } catch (error) {
      toast(`Could not load live data: ${error.message}`);
    }
    installSyncPill();
    renderNav();
    const initial = window.location.hash.slice(1);
    navPage(NAV.some((group) => group.items.some((item) => item[0] === initial)) ? initial : 'pos');
    setInterval(refreshSync, 30_000);
  })();
})();
