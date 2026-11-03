(function () {
  const state = {
    me: null,
    permissions: [],
    view: 'dashboard',
    params: {},
    menuItems: [],
    menuCategories: []
  };

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', abbr: 'DB', permission: 'dashboard.view', group: 'Operations' },
    { id: 'pos', label: 'POS terminal', abbr: 'PS', permission: 'pos.use', group: 'Operations', href: '/pos' },
    { id: 'orders', label: 'Orders', abbr: 'OR', permission: 'orders.view', group: 'Operations' },
    { id: 'tables', label: 'Floor & tables', abbr: 'FL', permission: 'floor.view', group: 'Operations' },
    { id: 'kitchen', label: 'Kitchen display', abbr: 'KD', permission: 'kitchen.view', group: 'Operations', href: '/kitchen' },
    { id: 'bar', label: 'Bar display', abbr: 'BR', permission: 'bar.view', group: 'Operations', href: '/bar' },
    { id: 'billing', label: 'Billing & payments', abbr: 'BL', permission: 'billing.view', group: 'Operations' },
    { id: 'handoff', label: 'Cashier handoff', abbr: 'CH', permission: 'billing.pay', group: 'Operations' },
    { id: 'reservations', label: 'Reservations', abbr: 'RS', permission: 'reservations.view', group: 'Operations' },
    { id: 'menu', label: 'Menu management', abbr: 'MN', permission: 'menu.view', group: 'Back office' },
    { id: 'inventory', label: 'Inventory', abbr: 'IN', permission: 'inventory.view', group: 'Back office' },
    { id: 'recipes', label: 'Recipes', abbr: 'RC', permission: 'inventory.view', group: 'Back office' },
    { id: 'purchasing', label: 'Purchasing', abbr: 'PO', permission: 'purchasing.view', group: 'Back office' },
    { id: 'suppliers', label: 'Suppliers', abbr: 'SU', permission: 'purchasing.view', group: 'Back office' },
    { id: 'customers', label: 'Customers', abbr: 'CU', permission: 'customers.view', group: 'Back office' },
    { id: 'expenses', label: 'Expenses', abbr: 'EX', permission: 'expenses.view', group: 'Back office' },
    { id: 'invoices', label: 'Invoices', abbr: 'IV', permission: 'billing.view', group: 'Back office' },
    { id: 'reports', label: 'Reports', abbr: 'RP', permission: 'reports.view', group: 'Back office', href: '/reports' },
    { id: 'staff', label: 'Staff & roles', abbr: 'ST', permission: 'staff.view', group: 'Administration' },
    { id: 'printers', label: 'Printers', abbr: 'PR', permission: 'printers.manage', group: 'Administration' },
    { id: 'qr', label: 'QR menu', abbr: 'QR', permission: 'menu.view', group: 'Administration', href: '/menu' },
    { id: 'audit', label: 'Audit log', abbr: 'AU', permission: 'audit.view', group: 'Administration' },
    { id: 'settings', label: 'Settings', abbr: 'SE', permission: 'settings.manage', group: 'Administration' },
    { id: 'license', label: 'License', abbr: 'LC', permission: 'settings.manage', group: 'Administration' }
  ];

  const viewContent = document.getElementById('view') || document.getElementById('viewContent');
  const navGroups = document.getElementById('navGroups');
  const modalLayer = document.getElementById('modalLayer') || document.getElementById('modal');
  const toast = document.getElementById('toast');
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('mobileScrim');

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(value) {
    const number = Number(value || 0);
    return number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function date(value) {
    if (!value) return '-';
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
  }

  function shortDate(value) {
    if (!value) return '-';
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString();
  }

  function initials(name) {
    return String(name || 'ERP')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (part) { return part.charAt(0).toUpperCase(); })
      .join('') || '--';
  }

  function can(permission) {
    if (!permission) return true;
    if (state.me && state.me.isSuperAdmin) return true;
    return state.permissions.indexOf('*') !== -1 || state.permissions.indexOf(permission) !== -1;
  }

  async function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin' }, options || {});
    if (opts.body && !opts.headers) opts.headers = { 'Content-Type': 'application/json' };
    const response = await fetch(path, opts);
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) {
        window.location.replace('/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash));
        throw new Error('Authentication required');
      }
      const error = new Error((data.error && data.error.message) || 'Request failed');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.classList.remove('show'); }, 2800);
  }

  function showError(error) {
    showToast(error && error.message ? error.message : 'Something went wrong');
  }

  function setLoading(label) {
    viewContent.innerHTML = '<div class="erp-empty">Loading ' + esc(label || 'data') + '...</div>';
  }

  function pageHead(title, subtitle, actions) {
    return '<div class="erp-view-head"><div><div class="eyebrow">MAISON ERP</div><h1>' + esc(title) + '</h1><p>' + esc(subtitle || '') + '</p></div><div class="erp-actions">' + (actions || '') + '</div></div>';
  }

  function statusTag(status) {
    const value = String(status || '').toUpperCase();
    let tone = 'gray';
    if (['PAID', 'COMPLETED', 'RECEIVED', 'ACTIVE', 'AVAILABLE', 'POSTED', 'SEATED'].indexOf(value) !== -1) tone = 'green';
    if (['OPEN', 'SUBMITTED', 'PREPARING', 'READY', 'PARTIAL', 'PARTIALLY_PAID', 'BOOKED', 'DRAFT', 'ISSUED'].indexOf(value) !== -1) tone = 'orange';
    if (['CANCELLED', 'VOID', 'NO_SHOW', 'MAINTENANCE'].indexOf(value) !== -1) tone = 'red';
    if (['SERVED', 'OCCUPIED', 'RESERVED', 'SENT', 'CLEANING'].indexOf(value) !== -1) tone = 'blue';
    return '<span class="erp-tag ' + tone + '">' + esc(value || '-') + '</span>';
  }

  function options(items, valueKey, labelKey, selected) {
    return (items || []).map(function (item) {
      const value = item[valueKey];
      return '<option value="' + esc(value) + '"' + (String(value) === String(selected) ? ' selected' : '') + '>' + esc(item[labelKey]) + '</option>';
    }).join('');
  }

  function renderNav() {
    const groups = {};
    navItems.forEach(function (item) {
      if (!can(item.permission)) return;
      groups[item.group] = groups[item.group] || [];
      groups[item.group].push(item);
    });
    navGroups.innerHTML = Object.keys(groups).map(function (group) {
      return '<div class="nav-caption">' + esc(group) + '</div>' + groups[group].map(function (item) {
        const href = item.href || ('#' + item.id);
        const active = !item.href && state.view === item.id ? ' active' : '';
        return '<a class="nav-item' + active + '" href="' + esc(href) + '"' + (item.href ? '' : ' data-view="' + item.id + '"') + '><span class="nav-abbr">' + item.abbr + '</span><span>' + esc(item.label) + '</span></a>';
      }).join('');
    }).join('');
  }

  function renderProfile() {
    const user = state.me || {};
    const role = state.roles && state.roles.length ? state.roles.map(function (item) { return item.name; }).join(', ') : 'ERP user';
    var set = function (id, value) {
      var el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    set('profileInitials', initials(user.name));
    set('topInitials', initials(user.name));
    set('profileName', user.name || 'ERP user');
    set('topName', user.name || 'ERP user');
    set('profileRole', role);
    set('topRole', role);
  }

  function openModal(title, html) {
    if (!modalLayer) return;
    modalLayer.innerHTML = '<div class="modal-box"><div class="modal-head"><h2 id="modalTitle">' + esc(title) + '</h2><button class="icon-button quiet" type="button" id="modalClose" aria-label="Close">Close</button></div><div class="modal-content erp-modal-body" id="modalBody"></div></div>';
    modalLayer.classList.add('open');
    modalLayer.setAttribute('aria-hidden', 'false');
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = html;
  }

  function closeModal() {
    if (!modalLayer) return;
    modalLayer.classList.remove('open');
    modalLayer.innerHTML = '';
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    scrim.classList.remove('open');
  }

  async function loadView(name, params) {
    if (!can((navItems.find(function (item) { return item.id === name; }) || {}).permission)) {
      name = 'dashboard';
    }
    state.view = name;
    state.params = params || {};
    renderNav();
    const nav = navItems.find(function (item) { return item.id === name; });
    document.getElementById('crumbLabel').textContent = nav ? nav.label : 'Dashboard';
    document.getElementById('topName').textContent = state.me ? state.me.name : 'ERP user';
    closeSidebar();
    setLoading(nav ? nav.label : 'dashboard');
    try {
      if (name === 'dashboard') await renderDashboard();
      else if (name === 'orders') await renderOrders();
      else if (name === 'tables') await renderTables();
      else if (name === 'billing') await renderBilling();
      else if (name === 'handoff') await renderHandoff();
      else if (name === 'reservations') await renderReservations();
      else if (name === 'menu') await renderMenuAdmin();
      else if (name === 'inventory') await renderInventory();
      else if (name === 'recipes') await renderRecipes();
      else if (name === 'purchasing') await renderPurchasing();
      else if (name === 'suppliers') await renderSuppliers();
      else if (name === 'customers') await renderCustomers();
      else if (name === 'expenses') await renderExpenses();
      else if (name === 'invoices') await renderInvoices();
      else if (name === 'staff') await renderStaff();
      else if (name === 'printers') await renderPrinters();
      else if (name === 'audit') await renderAudit();
      else if (name === 'settings') await renderSettings();
      else if (name === 'license') await renderLicense();
      else await renderDashboard();
    } catch (error) {
      viewContent.innerHTML = pageHead('Unable to load', '') + '<div class="erp-card"><div class="erp-empty">' + esc(error.message) + '</div></div>';
    }
  }

  async function renderDashboard() {
    const data = await api('/api/erp/dashboard');
    const summary = data.summary;
    const stats = [
      ['Orders today', summary.ordersToday, 'All channels'],
      ['Sales today', money(summary.salesToday), 'Paid orders'],
      ['Open orders', summary.openOrders, 'Needs attention'],
      ['Low stock', summary.lowStock, 'Ingredients below minimum']
    ];
    viewContent.innerHTML = pageHead('Dashboard', 'Live restaurant performance and operations.', '<a class="btn btn-outline" href="/">Open POS</a><button class="btn btn-primary" data-action="refresh">Refresh</button>')
      + '<div class="erp-grid-4">' + stats.map(function (item) {
        return '<div class="erp-card erp-stat"><span>' + esc(item[0]) + '</span><b>' + esc(item[1]) + '</b><small>' + esc(item[2]) + '</small></div>';
      }).join('') + '</div>'
      + '<div class="erp-grid-2" style="margin-top:13px">'
      + '<section class="erp-card"><div class="erp-card-head"><div><h2>Recent orders</h2><small>Latest activity across the restaurant.</small></div><a class="btn btn-small btn-outline" href="#orders">View all</a></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Order</th><th>Table</th><th>Type</th><th>Total</th><th>Status</th><th>Time</th></tr></thead><tbody>'
      + (data.recentOrders.length ? data.recentOrders.map(function (order) {
        return '<tr><td><strong>' + esc(order.orderNumber) + '</strong></td><td>' + esc(order.tableNumber || '-') + '</td><td>' + esc(order.type || '-') + '</td><td>' + money(order.total) + '</td><td>' + statusTag(order.status) + '</td><td>' + date(order.createdAt) + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="erp-empty">No orders yet.</td></tr>')
      + '</tbody></table></div></section>'
      + '<div class="erp-stack">'
      + '<section class="erp-card"><div class="erp-card-head"><div><h2>Low stock</h2><small>Items at or below minimum.</small></div><a class="btn btn-small btn-outline" href="#inventory">Inventory</a></div><div class="erp-card-body"><div class="erp-list">'
      + (data.lowStock.length ? data.lowStock.map(function (item) {
        return '<div class="erp-list-row"><div class="main"><b>' + esc(item.name) + '</b><small>' + money(item.currentStock) + ' ' + esc(item.unit) + ' remaining</small></div><span class="value">Min ' + money(item.minStock) + '</span></div>';
      }).join('') : '<div class="erp-empty">Everything is above minimum.</div>')
      + '</div></div></section>'
      + '<section class="erp-card"><div class="erp-card-head"><div><h2>Top items today</h2><small>By quantity sold.</small></div></div><div class="erp-card-body"><div class="erp-list">'
      + (data.topItems.length ? data.topItems.map(function (item) {
        return '<div class="erp-list-row"><div class="main"><b>' + esc(item.name) + '</b><small>' + money(item.quantity) + ' sold</small></div><span class="value">' + money(item.revenue) + '</span></div>';
      }).join('') : '<div class="erp-empty">No sales recorded today.</div>')
      + '</div></div></section>'
      + '<section class="erp-card"><div class="erp-card-head"><div><h2>Upcoming reservations</h2><small>Next guests in the book.</small></div><a class="btn btn-small btn-outline" href="#reservations">Manage</a></div><div class="erp-card-body"><div class="erp-list">'
      + (data.reservations.length ? data.reservations.map(function (item) {
        return '<div class="erp-list-row"><div class="main"><b>' + esc(item.guestName) + '</b><small>' + date(item.reservedAt) + ' - party of ' + esc(item.partySize) + '</small></div><span class="erp-tag">' + esc(item.status) + '</span></div>';
      }).join('') : '<div class="erp-empty">No upcoming reservations.</div>')
      + '</div></div></section></div></div>';
  }

  async function renderOrders() {
    const status = state.params.status || '';
    const data = await api('/api/erp/orders?limit=150' + (status ? '&status=' + encodeURIComponent(status) : ''));
    viewContent.innerHTML = pageHead('Orders', 'Review, advance, invoice, and refund orders.', '<a class="btn btn-outline" href="/">New order in POS</a>')
      + '<div class="erp-toolbar"><select class="soft-select" data-filter-status><option value="">All statuses</option>' + ['SUBMITTED', 'PREPARING', 'READY', 'SERVED', 'PAID', 'COMPLETED', 'CANCELLED', 'VOID'].map(function (item) { return '<option value="' + item + '"' + (status === item ? ' selected' : '') + '>' + item + '</option>'; }).join('') + '</select><span class="space"></span><span class="erp-tag">' + data.orders.length + ' orders</span></div>'
      + '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Order</th><th>Table</th><th>Type</th><th>Total</th><th>Paid</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>'
      + (data.orders.length ? data.orders.map(function (order) {
        return '<tr><td><strong>' + esc(order.orderNumber) + '</strong><br><small>' + esc(order.customerName || 'Walk-in') + '</small></td><td>' + esc(order.tableNumber || '-') + '</td><td>' + esc(order.type || '-') + '</td><td>' + money(order.total) + '</td><td>' + money(order.paidTotal) + '</td><td>' + statusTag(order.status) + '</td><td>' + date(order.createdAt) + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="order-view" data-id="' + esc(order.uuid) + '">View</button><button class="btn btn-small btn-soft" data-action="order-invoice" data-id="' + esc(order.uuid) + '">Invoice</button></div></td></tr>';
      }).join('') : '<tr><td colspan="8" class="erp-empty">No orders found.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderTables() {
    const results = await Promise.all([api('/api/erp/tables'), api('/api/erp/floors')]);
    const tables = results[0].tables;
    const floors = results[1].floors;
    viewContent.innerHTML = pageHead('Floor & tables', 'Live table status and dining floor setup.', '<button class="btn btn-primary" data-action="table-create">Add table</button>')
      + '<div class="erp-grid-2"><section class="erp-card"><div class="erp-card-head"><div><h2>Tables</h2><small>' + tables.length + ' tables across ' + floors.length + ' floors.</small></div></div><div class="erp-card-body"><div class="erp-floor-grid">'
      + (tables.length ? tables.map(function (table) {
        return '<div class="erp-table-tile ' + esc(String(table.status || '').toLowerCase()) + '"><b>' + esc(table.number) + '</b><small>' + esc(table.name || '') + ' - ' + esc(table.capacity) + ' seats<br>' + esc(table.floorName || table.sectionName || 'Main floor') + '</small><div class="tile-actions"><select class="soft-select" style="min-height:26px;font-size:8px;padding:0 4px" data-table-status data-id="' + table.id + '">' + ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'MAINTENANCE'].map(function (item) { return '<option value="' + item + '"' + (table.status === item ? ' selected' : '') + '>' + item + '</option>'; }).join('') + '</select></div></div>';
      }).join('') : '<div class="erp-empty">No tables yet.</div>')
      + '</div></div></section><div class="erp-stack"><section class="erp-card"><div class="erp-card-head"><div><h2>Floors & sections</h2><small>Dining areas configured for this venue.</small></div><button class="btn btn-small btn-outline" data-action="floor-create">Add floor</button></div><div class="erp-card-body"><div class="erp-list">'
      + (floors.length ? floors.map(function (floor) {
        return '<div class="erp-list-row"><div class="main"><b>' + esc(floor.name) + '</b><small>' + (floor.sections.length ? floor.sections.map(function (section) { return section.name; }).join(', ') : 'No sections') + '</small></div><span class="erp-tag green">' + (floor.active ? 'Active' : 'Inactive') + '</span></div>';
      }).join('') : '<div class="erp-empty">No floors yet.</div>')
      + '</div></div></section><section class="erp-card"><div class="erp-card-head"><div><h2>Quick actions</h2><small>Common floor operations.</small></div></div><div class="erp-card-body"><div class="erp-list"><div class="erp-list-row"><div class="main"><b>Point of sale</b><small>Create and pay orders.</small></div><a class="btn btn-small btn-soft" href="/">Open POS</a></div><div class="erp-list-row"><div class="main"><b>Reservations</b><small>Seat booked guests.</small></div><a class="btn btn-small btn-outline" href="#reservations">Open</a></div></div></div></section></div></div>';
  }

  async function renderReservations() {
    const data = await api('/api/erp/reservations');
    viewContent.innerHTML = pageHead('Reservations', 'Manage the reservation book and guest seating.', '<button class="btn btn-primary" data-action="reservation-create">New reservation</button>')
      + '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Guest</th><th>Party</th><th>Table</th><th>Reserved at</th><th>Status</th><th>Phone</th><th>Actions</th></tr></thead><tbody>'
      + (data.reservations.length ? data.reservations.map(function (item) {
        return '<tr><td><strong>' + esc(item.guestName) + '</strong><br><small>' + esc(item.notes || '') + '</small></td><td>' + esc(item.partySize) + '</td><td>' + esc(item.tableNumber || '-') + '</td><td>' + date(item.reservedAt) + '</td><td>' + statusTag(item.status) + '</td><td>' + esc(item.phone || '-') + '</td><td><select class="soft-select" style="min-height:29px;font-size:9px" data-reservation-status data-id="' + item.id + '">' + ['BOOKED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].map(function (status) { return '<option value="' + status + '"' + (item.status === status ? ' selected' : '') + '>' + status + '</option>'; }).join('') + '</select></td></tr>';
      }).join('') : '<tr><td colspan="7" class="erp-empty">No reservations yet.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderInventory() {
    const data = await api('/api/erp/inventory');
    viewContent.innerHTML = pageHead('Inventory', 'Ingredient stock, movements, and low-stock alerts.', '<button class="btn btn-primary" data-action="ingredient-create">Add ingredient</button>')
      + '<div class="erp-grid-4"><div class="erp-card erp-stat"><span>Ingredients</span><b>' + data.totals.items + '</b><small>Active stock items</small></div><div class="erp-card erp-stat"><span>Low stock</span><b>' + data.totals.lowStock + '</b><small>At or below minimum</small></div><div class="erp-card erp-stat"><span>Stock value</span><b>' + money(data.totals.stockValue) + '</b><small>At cost</small></div><div class="erp-card erp-stat"><span>Movements</span><b>' + data.movements.length + '</b><small>Recent entries</small></div></div>'
      + '<div class="erp-grid-2" style="margin-top:13px"><section class="erp-card"><div class="erp-card-head"><div><h2>Ingredients</h2><small>Adjust stock or update minimums.</small></div></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Ingredient</th><th>Stock</th><th>Minimum</th><th>Unit cost</th><th>Value</th><th>Actions</th></tr></thead><tbody>'
      + (data.ingredients.length ? data.ingredients.map(function (item) {
        return '<tr><td><strong>' + esc(item.name) + '</strong><br><small>' + esc(item.sku || '') + ' ' + esc(item.supplierName || '') + '</small></td><td>' + money(item.currentStock) + ' ' + esc(item.unit) + (item.lowStock ? ' <span class="erp-tag red">Low</span>' : '') + '</td><td>' + money(item.minStock) + '</td><td>' + money(item.costPerUnit) + '</td><td>' + money(item.stockValue) + '</td><td><button class="btn btn-small btn-outline" data-action="inventory-adjust" data-id="' + item.id + '" data-name="' + esc(item.name) + '" data-unit="' + esc(item.unit) + '">Adjust</button></td></tr>';
      }).join('') : '<tr><td colspan="6" class="erp-empty">No ingredients yet.</td></tr>')
      + '</tbody></table></div></section><section class="erp-card"><div class="erp-card-head"><div><h2>Recent movements</h2><small>Stock in, out, and adjustments.</small></div></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Ingredient</th><th>Type</th><th>Qty</th><th>Reference</th><th>Time</th></tr></thead><tbody>'
      + (data.movements.length ? data.movements.map(function (item) {
        return '<tr><td><strong>' + esc(item.ingredientName || '-') + '</strong></td><td>' + statusTag(item.movementType) + '</td><td>' + money(item.quantity) + '</td><td>' + esc(item.referenceId || item.referenceType || '-') + '</td><td>' + date(item.createdAt) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="erp-empty">No stock movements yet.</td></tr>')
      + '</tbody></table></div></section></div>';
  }

  async function renderRecipes() {
    const results = await Promise.all([api('/api/erp/recipes'), api('/api/erp/inventory'), api('/api/public/menu')]);
    const recipes = results[0].recipes;
    const ingredients = results[1].ingredients;
    const menu = results[2].items || [];
    viewContent.innerHTML = pageHead('Recipes', 'Ingredient consumption for each menu item.', '<button class="btn btn-primary" data-action="recipe-create">Add recipe</button>')
      + '<div class="erp-grid-2"><section class="erp-stack">'
      + (recipes.length ? recipes.map(function (recipe) {
        return '<article class="erp-card"><div class="erp-card-head"><div><h2>' + esc(recipe.menuItemName || recipe.name) + '</h2><small>Yield ' + esc(recipe.yieldQty) + ' - cost ' + money(recipe.cost) + '</small></div><div class="erp-actions"><button class="btn btn-small btn-outline" data-action="recipe-line-add" data-id="' + recipe.id + '">Add line</button></div></div><div class="erp-card-body"><div class="erp-recipe-lines">'
          + (recipe.lines.length ? recipe.lines.map(function (line) {
            return '<div class="erp-recipe-line"><span>' + esc(line.ingredientName || 'Ingredient') + ' - ' + money(line.quantity) + ' ' + esc(line.unit || '') + '</span><span>' + money(line.costPerUnit || 0) + ' / unit <button class="btn btn-small btn-outline" data-action="recipe-line-delete" data-id="' + line.id + '">Remove</button></span></div>';
          }).join('') : '<div class="erp-empty">No ingredient lines yet.</div>')
          + '</div></div></article>';
      }).join('') : '<div class="erp-card"><div class="erp-empty">No recipes yet. Add one to start tracking ingredient usage.</div></div>')
      + '</section><section class="erp-card"><div class="erp-card-head"><div><h2>Available ingredients</h2><small>Use these when adding recipe lines.</small></div></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Ingredient</th><th>Stock</th><th>Unit</th><th>Cost</th></tr></thead><tbody>'
      + (ingredients.length ? ingredients.map(function (item) {
        return '<tr><td><strong>' + esc(item.name) + '</strong></td><td>' + money(item.currentStock) + '</td><td>' + esc(item.unit) + '</td><td>' + money(item.costPerUnit) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="erp-empty">No ingredients yet.</td></tr>')
      + '</tbody></table></div></section></div>'
      + '<input type="hidden" id="menuItemsData" value="' + esc(JSON.stringify(menu)) + '"><input type="hidden" id="ingredientsData" value="' + esc(JSON.stringify(ingredients)) + '">';
  }

  async function renderPurchasing() {
    const results = await Promise.all([api('/api/erp/purchases'), api('/api/erp/suppliers'), api('/api/erp/inventory')]);
    const purchases = results[0].purchases;
    const suppliers = results[1].suppliers;
    const ingredients = results[2].ingredients;
    viewContent.innerHTML = pageHead('Purchasing', 'Purchase orders and receiving.', '<button class="btn btn-primary" data-action="purchase-create">New purchase order</button>')
      + '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>PO</th><th>Supplier</th><th>Status</th><th>Order date</th><th>Expected</th><th>Total</th><th>Actions</th></tr></thead><tbody>'
      + (purchases.length ? purchases.map(function (item) {
        return '<tr><td><strong>' + esc(item.poNumber) + '</strong></td><td>' + esc(item.supplierName || '-') + '</td><td>' + statusTag(item.status) + '</td><td>' + shortDate(item.orderDate) + '</td><td>' + shortDate(item.expectedAt) + '</td><td>' + money(item.total) + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="purchase-view" data-id="' + item.id + '">View</button><button class="btn btn-small btn-soft" data-action="purchase-receive" data-id="' + item.id + '">Receive</button><button class="btn btn-small btn-outline" data-action="purchase-cancel" data-id="' + item.id + '">Cancel</button></div></td></tr>';
      }).join('') : '<tr><td colspan="7" class="erp-empty">No purchase orders yet.</td></tr>')
      + '</tbody></table></div></section>'
      + '<input type="hidden" id="suppliersData" value="' + esc(JSON.stringify(suppliers)) + '"><input type="hidden" id="ingredientsData" value="' + esc(JSON.stringify(ingredients)) + '">';
  }

  async function renderSuppliers() {
    const data = await api('/api/erp/suppliers');
    viewContent.innerHTML = pageHead('Suppliers', 'Vendor contacts and purchasing relationships.', '<button class="btn btn-primary" data-action="supplier-create">Add supplier</button>')
      + '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Email</th><th>Tax number</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + (data.suppliers.length ? data.suppliers.map(function (item) {
        return '<tr><td><strong>' + esc(item.name) + '</strong><br><small>' + esc(item.address || '') + '</small></td><td>' + esc(item.contactName || '-') + '</td><td>' + esc(item.phone || '-') + '</td><td>' + esc(item.email || '-') + '</td><td>' + esc(item.taxNumber || '-') + '</td><td>' + (item.active ? '<span class="erp-tag green">Active</span>' : '<span class="erp-tag red">Inactive</span>') + '</td><td><button class="btn btn-small btn-outline" data-action="supplier-toggle" data-id="' + item.id + '">' + (item.active ? 'Disable' : 'Enable') + '</button></td></tr>';
      }).join('') : '<tr><td colspan="7" class="erp-empty">No suppliers yet.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderCustomers() {
    const data = await api('/api/erp/customers');
    viewContent.innerHTML = pageHead('Customers', 'Guest profiles, spend, and loyalty.', '<button class="btn btn-primary" data-action="customer-create">Add customer</button>')
      + '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th>Visits</th><th>Total spent</th><th>Loyalty</th><th>Actions</th></tr></thead><tbody>'
      + (data.customers.length ? data.customers.map(function (item) {
        return '<tr><td><strong>' + esc(item.name) + '</strong><br><small>' + esc(item.address || '') + '</small></td><td>' + esc(item.phone || '-') + '</td><td>' + esc(item.email || '-') + '</td><td>' + esc(item.visits || 0) + '</td><td>' + money(item.totalSpent) + '</td><td>' + esc(item.loyaltyPoints || 0) + '</td><td><button class="btn btn-small btn-outline" data-action="customer-view" data-id="' + item.id + '">View</button></td></tr>';
      }).join('') : '<tr><td colspan="7" class="erp-empty">No customers yet.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderExpenses() {
    const data = await api('/api/erp/expenses');
    viewContent.innerHTML = pageHead('Expenses', 'Operating costs and supplier payments.', '<button class="btn btn-primary" data-action="expense-create">Record expense</button>')
      + '<div class="erp-grid-4"><div class="erp-card erp-stat"><span>Expenses</span><b>' + data.expenses.length + '</b><small>Recorded entries</small></div><div class="erp-card erp-stat"><span>Total</span><b>' + money(data.total) + '</b><small>All listed expenses</small></div></div>'
      + '<section class="erp-card" style="margin-top:13px"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Category</th><th>Note</th><th>Supplier</th><th>Amount</th><th>Method</th><th>Paid at</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + (data.expenses.length ? data.expenses.map(function (item) {
        return '<tr><td><strong>' + esc(item.category) + '</strong></td><td>' + esc(item.note || '-') + '</td><td>' + esc(item.supplierName || '-') + '</td><td>' + money(item.amount) + '</td><td>' + esc(item.paymentMethod || '-') + '</td><td>' + date(item.paidAt) + '</td><td>' + statusTag(item.status) + '</td><td><button class="btn btn-small btn-outline" data-action="expense-delete" data-id="' + item.id + '">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="8" class="erp-empty">No expenses yet.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderInvoices() {
    const data = await api('/api/erp/invoices');
    viewContent.innerHTML = pageHead('Invoices', 'Issued invoices and payment status.', '')
      + '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Invoice</th><th>Order</th><th>Customer</th><th>Total</th><th>Paid</th><th>Status</th><th>Issued</th><th>Actions</th></tr></thead><tbody>'
      + (data.invoices.length ? data.invoices.map(function (item) {
        return '<tr><td><strong>' + esc(item.invoiceNumber) + '</strong></td><td>' + esc(item.orderNumber || '-') + '</td><td>' + esc(item.customerName || 'Walk-in') + '</td><td>' + money(item.total) + '</td><td>' + money(item.paidTotal) + '</td><td>' + statusTag(item.status) + '</td><td>' + date(item.issuedAt) + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="invoice-view" data-id="' + item.id + '">View</button><button class="btn btn-small btn-soft" data-action="invoice-pay" data-id="' + item.id + '">Pay</button><button class="btn btn-small btn-outline" data-action="invoice-void" data-id="' + item.id + '">Void</button></div></td></tr>';
      }).join('') : '<tr><td colspan="8" class="erp-empty">No invoices yet. Create one from an order.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function loadPrintJobs() {
    try {
      const response = await fetch('/api/print/jobs', { credentials: 'same-origin' });
      if (!response.ok) return { jobs: [], unavailable: true };
      const data = await response.json();
      return { jobs: data.jobs || [], unavailable: false };
    } catch (error) {
      return { jobs: [], unavailable: true };
    }
  }

  function printJobsTable(jobs) {
    return '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Job</th><th>Document</th><th>Station</th><th>Order</th><th>Status</th><th>Created</th><th>Payload</th></tr></thead><tbody>'
      + (jobs.length ? jobs.map(function (job) {
        return '<tr><td><strong>' + esc(job.job_number) + '</strong></td><td>' + esc(job.document_type) + '</td><td>' + esc(job.station || '-') + '</td><td>' + esc(job.order_sync_id || '-') + '</td><td>' + statusTag(job.status) + '</td><td>' + date(job.created_at) + '</td><td><details><summary>View</summary><pre style="white-space:pre-wrap;font-size:10px;max-width:360px">' + esc(job.payload || '') + '</pre></details></td></tr>';
      }).join('') : '<tr><td colspan="7" class="erp-empty">No print jobs queued.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderBilling() {
    const results = await Promise.all([api('/api/erp/orders?limit=150'), api('/api/erp/invoices')]);
    const orders = results[0].orders;
    const invoices = results[1].invoices;
    const openOrders = orders.filter(function (order) { return ['PAID', 'COMPLETED', 'CANCELLED', 'VOID'].indexOf(String(order.status).toUpperCase()) === -1; });
    const dueInvoices = invoices.filter(function (item) { return ['PAID', 'VOID', 'CANCELLED'].indexOf(String(item.status).toUpperCase()) === -1; });
    const dueTotal = dueInvoices.reduce(function (sum, item) { return sum + Math.max(0, Number(item.total) - Number(item.paidTotal)); }, 0);
    viewContent.innerHTML = pageHead('Billing & payments', 'Collect payment, issue invoices, and settle balances.', '<a class="btn btn-outline" href="/pos">Open POS</a>')
      + '<div class="erp-grid-4"><div class="erp-card erp-stat"><span>Open orders</span><b>' + openOrders.length + '</b><small>Awaiting payment</small></div><div class="erp-card erp-stat"><span>Due invoices</span><b>' + dueInvoices.length + '</b><small>Unpaid balances</small></div><div class="erp-card erp-stat"><span>Outstanding</span><b>' + money(dueTotal) + '</b><small>To collect</small></div><div class="erp-card erp-stat"><span>Invoices</span><b>' + invoices.length + '</b><small>All issued</small></div></div>'
      + '<section class="erp-card" style="margin-top:13px"><div class="erp-card-head"><div><h2>Open orders</h2><small>Orders that still need settlement.</small></div></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Order</th><th>Table</th><th>Total</th><th>Paid</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + (openOrders.length ? openOrders.map(function (order) {
        return '<tr><td><strong>' + esc(order.orderNumber) + '</strong><br><small>' + esc(order.customerName || 'Walk-in') + '</small></td><td>' + esc(order.tableNumber || '-') + '</td><td>' + money(order.total) + '</td><td>' + money(order.paidTotal) + '</td><td>' + statusTag(order.status) + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="order-view" data-id="' + esc(order.uuid) + '">View</button><button class="btn btn-small btn-soft" data-action="order-invoice" data-id="' + esc(order.uuid) + '">Invoice</button></div></td></tr>';
      }).join('') : '<tr><td colspan="6" class="erp-empty">No open orders.</td></tr>')
      + '</tbody></table></div></section>'
      + '<section class="erp-card" style="margin-top:13px"><div class="erp-card-head"><div><h2>Invoices</h2><small>Record payments and review issued invoices.</small></div><a class="btn btn-small btn-outline" href="#invoices">All invoices</a></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Invoice</th><th>Order</th><th>Total</th><th>Paid</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + (invoices.length ? invoices.map(function (item) {
        return '<tr><td><strong>' + esc(item.invoiceNumber) + '</strong></td><td>' + esc(item.orderNumber || '-') + '</td><td>' + money(item.total) + '</td><td>' + money(item.paidTotal) + '</td><td>' + statusTag(item.status) + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="invoice-view" data-id="' + item.id + '">View</button><button class="btn btn-small btn-soft" data-action="invoice-pay" data-id="' + item.id + '">Pay</button></div></td></tr>';
      }).join('') : '<tr><td colspan="6" class="erp-empty">No invoices yet.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderHandoff() {
    const results = await Promise.all([api('/api/erp/orders?limit=150'), loadPrintJobs()]);
    const readyOrders = results[0].orders.filter(function (order) { return ['READY', 'SERVED'].indexOf(String(order.status).toUpperCase()) !== -1; });
    const print = results[1];
    viewContent.innerHTML = pageHead('Cashier handoff', 'Ready tickets, invoice creation, and the print queue.', '<button class="btn btn-outline" data-action="print-test">Test print</button><button class="btn btn-primary" data-action="print-process">Process queue</button>')
      + '<div class="erp-grid-4"><div class="erp-card erp-stat"><span>Ready orders</span><b>' + readyOrders.length + '</b><small>Awaiting handoff</small></div><div class="erp-card erp-stat"><span>Queued jobs</span><b>' + print.jobs.filter(function (job) { return job.status === 'QUEUED'; }).length + '</b><small>Print queue</small></div><div class="erp-card erp-stat"><span>Printed</span><b>' + print.jobs.filter(function (job) { return job.status === 'PRINTED'; }).length + '</b><small>Recent jobs</small></div><div class="erp-card erp-stat"><span>Failed</span><b>' + print.jobs.filter(function (job) { return job.status === 'FAILED'; }).length + '</b><small>Needs attention</small></div></div>'
      + '<section class="erp-card" style="margin-top:13px"><div class="erp-card-head"><div><h2>Ready for handoff</h2><small>Create an invoice, then collect payment.</small></div></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Order</th><th>Table</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + (readyOrders.length ? readyOrders.map(function (order) {
        return '<tr><td><strong>' + esc(order.orderNumber) + '</strong></td><td>' + esc(order.tableNumber || '-') + '</td><td>' + money(order.total) + '</td><td>' + statusTag(order.status) + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="order-view" data-id="' + esc(order.uuid) + '">View</button><button class="btn btn-small btn-soft" data-action="order-invoice" data-id="' + esc(order.uuid) + '">Invoice</button></div></td></tr>';
      }).join('') : '<tr><td colspan="5" class="erp-empty">No orders waiting for handoff.</td></tr>')
      + '</tbody></table></div></section>'
      + (print.unavailable ? '<div class="erp-card" style="margin-top:13px"><div class="erp-empty">The print queue is only available on the local install.</div></div>' : '<div style="margin-top:13px">' + printJobsTable(print.jobs.slice(0, 10)) + '</div>');
  }

  async function renderMenuAdmin() {
    const data = await api('/api/admin/menu');
    state.menuItems = data.items || [];
    state.menuCategories = data.categories || [];
    viewContent.innerHTML = pageHead('Menu management', 'Categories, dishes, pricing, and availability.', '<button class="btn btn-primary" data-action="menu-item-create">Add item</button><button class="btn btn-outline" data-action="menu-category-create">Add category</button>')
      + '<div class="erp-grid-2"><section class="erp-card"><div class="erp-card-head"><div><h2>Categories</h2><small>' + state.menuCategories.length + ' categories</small></div></div><div class="erp-card-body"><div class="erp-list">'
      + (state.menuCategories.length ? state.menuCategories.map(function (category) {
        return '<div class="erp-list-row"><div class="main"><b>' + esc(category.name) + '</b><small>Sort ' + esc(category.sort) + '</small></div><button class="btn btn-small btn-outline" data-action="menu-category-edit" data-id="' + category.id + '">Edit</button></div>';
      }).join('') : '<div class="erp-empty">No categories yet.</div>')
      + '</div></div></section><section class="erp-card"><div class="erp-card-head"><div><h2>Dishes & drinks</h2><small>' + state.menuItems.length + ' menu items</small></div></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Station</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + (state.menuItems.length ? state.menuItems.map(function (item) {
        return '<tr><td><strong>' + esc(item.name) + '</strong><br><small>' + esc(item.desc || '') + '</small></td><td>' + esc(item.category || '-') + '</td><td>' + money(item.price) + '</td><td>' + esc(item.station || '-') + '</td><td>' + (item.soldOut ? '<span class="erp-tag red">Sold out</span>' : item.available === false ? '<span class="erp-tag gray">Unavailable</span>' : '<span class="erp-tag green">Available</span>') + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="menu-item-edit" data-id="' + item.id + '">Edit</button><button class="btn btn-small btn-soft" data-action="menu-item-toggle" data-id="' + item.id + '">' + (item.available === false ? 'Enable' : 'Disable') + '</button><button class="btn btn-small btn-outline" data-action="menu-item-delete" data-id="' + item.id + '">Delete</button></div></td></tr>';
      }).join('') : '<tr><td colspan="6" class="erp-empty">No menu items yet.</td></tr>')
      + '</tbody></table></div></section></div>';
  }

  async function renderPrinters() {
    const print = await loadPrintJobs();
    viewContent.innerHTML = pageHead('Printers', 'Receipt and kitchen ticket queue.', '<button class="btn btn-outline" data-action="print-test">Test print</button><button class="btn btn-primary" data-action="print-process">Process queue</button>')
      + (print.unavailable ? '<div class="erp-card"><div class="erp-empty">The print queue is only available on the local install.</div></div>' : '<div class="erp-grid-4"><div class="erp-card erp-stat"><span>Queued</span><b>' + print.jobs.filter(function (job) { return job.status === 'QUEUED'; }).length + '</b><small>Waiting</small></div><div class="erp-card erp-stat"><span>Printed</span><b>' + print.jobs.filter(function (job) { return job.status === 'PRINTED'; }).length + '</b><small>Completed</small></div><div class="erp-card erp-stat"><span>Failed</span><b>' + print.jobs.filter(function (job) { return job.status === 'FAILED'; }).length + '</b><small>Needs attention</small></div><div class="erp-card erp-stat"><span>Total</span><b>' + print.jobs.length + '</b><small>Recent jobs</small></div></div><div style="margin-top:13px">' + printJobsTable(print.jobs) + '</div>');
  }

  function openMenuItemForm(item) {
    const current = item || {};
    openModal(current.id ? 'Edit menu item' : 'Add menu item', '<form data-form="menu-item" data-id="' + (current.id || '') + '"><input type="hidden" name="id" value="' + esc(current.id || '') + '"><div class="erp-form-grid"><label>Name<input class="soft-input" name="name" value="' + esc(current.name || '') + '" required></label><label>Price<input class="soft-input" name="price" type="number" step="0.01" min="0" value="' + esc(current.price == null ? '' : current.price) + '" required></label><label>Category<select class="soft-select" name="categoryId" required>' + options(state.menuCategories, 'id', 'name', current.categoryId) + '</select></label><label>Station<select class="soft-select" name="station">' + ['Kitchen', 'Bar'].map(function (station) { return '<option value="' + station + '"' + (current.station === station ? ' selected' : '') + '>' + station + '</option>'; }).join('') + '</select></label><label class="erp-form-wide">Description<textarea class="soft-input" name="description" rows="3">' + esc(current.desc || '') + '</textarea></label><label class="erp-check"><input type="checkbox" name="available"' + (current.available === false ? '' : ' checked') + '> Available</label><label class="erp-check"><input type="checkbox" name="soldOut"' + (current.soldOut ? ' checked' : '') + '> Sold out</label><label class="erp-check"><input type="checkbox" name="featured"' + (current.featured ? ' checked' : '') + '> Featured</label></div><div class="erp-actions" style="margin-top:14px"><button class="btn btn-primary" type="submit">Save item</button></div></form>');
  }

  function openMenuCategoryForm(category) {
    const current = category || {};
    const html = '<form data-form="menu-category" data-id="' + (current.id || '') + '">'
      + '<input type="hidden" name="id" value="' + esc(current.id || '') + '">'
      + '<div class="erp-form-grid"><label>Name<input class="soft-input" name="name" value="' + esc(current.name || '') + '" required></label>'
      + '<label>Sort order<input class="soft-input" name="sort" type="number" value="' + esc(current.sort == null ? 0 : current.sort) + '"></label></div>'
      + '<div class="erp-actions" style="margin-top:14px"><button class="btn btn-primary" type="submit">Save category</button></div></form>';
    openModal(current.id ? 'Edit category' : 'Add category', html);
  }

  async function renderStaff() {
    const results = await Promise.all([api('/api/erp/users'), api('/api/erp/roles'), api('/api/erp/permissions')]);
    const users = results[0].users;
    const roles = results[1].roles;
    state.roles = roles;
    renderProfile();
    const permissions = results[2].permissions;
    viewContent.innerHTML = pageHead('Staff & roles', 'User accounts, role assignments, and permissions.', '<button class="btn btn-primary" data-action="user-create">Add user</button>')
      + '<div class="erp-grid-2"><section class="erp-card"><div class="erp-card-head"><div><h2>Users</h2><small>' + users.length + ' active accounts.</small></div></div><div class="erp-table-card"><table class="erp-table"><thead><tr><th>User</th><th>Email</th><th>Roles</th><th>Last login</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + (users.length ? users.map(function (item) {
        return '<tr><td><strong>' + esc(item.name) + '</strong>' + (item.isSuperAdmin ? ' <span class="erp-tag dark">Super</span>' : '') + '</td><td>' + esc(item.email) + '</td><td>' + esc((item.roles || []).map(function (role) { return role.name; }).join(', ') || '-') + '</td><td>' + date(item.lastLoginAt) + '</td><td>' + (item.active ? '<span class="erp-tag green">Active</span>' : '<span class="erp-tag red">Disabled</span>') + '</td><td><div class="actions"><button class="btn btn-small btn-outline" data-action="user-edit" data-id="' + item.id + '">Edit</button><button class="btn btn-small btn-outline" data-action="user-toggle" data-id="' + item.id + '">' + (item.active ? 'Disable' : 'Enable') + '</button></div></td></tr>';
      }).join('') : '<tr><td colspan="6" class="erp-empty">No users yet.</td></tr>')
      + '</tbody></table></div></section><section class="erp-card"><div class="erp-card-head"><div><h2>Roles</h2><small>Permission bundles for staff.</small></div></div><div class="erp-card-body"><div class="erp-list">'
      + (roles.length ? roles.map(function (role) {
        return '<div class="erp-list-row"><div class="main"><b>' + esc(role.name) + '</b><small>' + esc(role.code) + ' - ' + (role.permissions ? role.permissions.length : 0) + ' permissions</small></div><button class="btn btn-small btn-outline" data-action="role-edit" data-id="' + role.id + '">Edit</button></div>';
      }).join('') : '<div class="erp-empty">No roles yet.</div>')
      + '</div></div></section></div>'
      + '<input type="hidden" id="rolesData" value="' + esc(JSON.stringify(roles)) + '"><input type="hidden" id="permissionsData" value="' + esc(JSON.stringify(permissions)) + '">';
  }

  async function renderAudit() {
    const data = await api('/api/erp/audit?limit=100');
    viewContent.innerHTML = pageHead('Audit log', 'Security and operational event history.', '<button class="btn btn-outline" data-action="refresh">Refresh</button>')
      + '<section class="erp-card"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead><tbody>'
      + (data.logs.length ? data.logs.map(function (item) {
        return '<tr><td>' + date(item.createdAt) + '</td><td><strong>' + esc(item.userName || '-') + '</strong></td><td>' + esc(item.action) + '</td><td>' + esc(item.entity || '-') + (item.entityId ? ' #' + esc(item.entityId) : '') + '</td><td><small>' + esc(item.details || '') + '</small></td><td>' + esc(item.ip || '-') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="erp-empty">No audit events yet.</td></tr>')
      + '</tbody></table></div></section>';
  }

  async function renderSettings() {
    const data = await api('/api/erp/settings');
    const s = data.settings;
    viewContent.innerHTML = pageHead('Settings', 'Restaurant identity, tax, receipts, and stock behavior.', '')
      + '<section class="erp-card"><div class="erp-card-body padded"><form class="erp-form" data-form="settings"><div class="erp-form-row three"><div><label class="form-label">Restaurant name</label><input class="form-control" name="restaurantName" value="' + esc(s.restaurant_name) + '" required></div><div><label class="form-label">Currency</label><input class="form-control" name="currency" value="' + esc(s.currency) + '" required></div><div><label class="form-label">Tax number</label><input class="form-control" name="taxNumber" value="' + esc(s.tax_number || '') + '"></div></div><div class="erp-form-row three"><div><label class="form-label">Tax rate</label><input class="form-control" type="number" step="0.01" name="taxRate" value="' + esc(s.tax_rate) + '"></div><div><label class="form-label">Service charge rate</label><input class="form-control" type="number" step="0.01" name="serviceChargeRate" value="' + esc(s.service_charge_rate) + '"></div><div><label class="form-label">Invoice prefix</label><input class="form-control" name="invoicePrefix" value="' + esc(s.invoice_prefix || 'INV') + '"></div></div><div class="erp-form-row"><div><label class="form-label">Phone</label><input class="form-control" name="phone" value="' + esc(s.phone || '') + '"></div><div><label class="form-label">Email</label><input class="form-control" name="email" value="' + esc(s.email || '') + '"></div></div><div><label class="form-label">Address</label><input class="form-control" name="address" value="' + esc(s.address || '') + '"></div><div><label class="form-label">Receipt header</label><input class="form-control" name="receiptHeader" value="' + esc(s.receipt_header || '') + '"></div><div><label class="form-label">Receipt footer</label><input class="form-control" name="receiptFooter" value="' + esc(s.receipt_footer || '') + '"></div><div class="erp-form-row"><label class="erp-list-row"><input type="checkbox" name="taxEnabled"' + (s.tax_enabled ? ' checked' : '') + '> Tax enabled</label><label class="erp-list-row"><input type="checkbox" name="serviceChargeEnabled"' + (s.service_charge_enabled ? ' checked' : '') + '> Service charge enabled</label></div><div class="erp-form-row"><label class="erp-list-row"><input type="checkbox" name="deductStockOnSubmit"' + (s.deduct_stock_on_submit ? ' checked' : '') + '> Deduct stock on submit</label><label class="erp-list-row"><input type="checkbox" name="lowStockAlerts"' + (s.low_stock_alerts ? ' checked' : '') + '> Low stock alerts</label></div><button class="btn btn-primary" type="submit">Save settings</button></form></div></section>';
  }

  async function renderLicense() {
    const data = await api('/api/erp/license');
    const license = data.license;
    viewContent.innerHTML = pageHead('License', 'Activation and signed license issuance for this installation.', '<a class="btn btn-outline" href="/license/activate">Full license page</a>')
      + '<div class="erp-grid-2"><section class="erp-card"><div class="erp-card-head"><div><h2>Current license</h2><small>Machine-bound activation.</small></div><span class="erp-tag ' + (license.active ? 'green' : 'red') + '">' + (license.active ? 'Active' : 'Inactive') + '</span></div><div class="erp-card-body"><div class="erp-list"><div class="erp-list-row"><div class="main"><b>Status</b><small>' + esc(license.reason || 'License is active for this machine.') + '</small></div></div><div class="erp-list-row"><div class="main"><b>Machine ID</b><small>' + esc(data.machine) + '</small></div></div><div class="erp-list-row"><div class="main"><b>Issued to</b><small>' + esc(license.issuedTo || '-') + '</small></div></div><div class="erp-list-row"><div class="main"><b>Expires</b><small>' + date(license.expiresAt) + '</small></div></div></div></div></section><div class="erp-stack"><section class="erp-card"><div class="erp-card-head"><div><h2>Activate key</h2><small>Paste a signed key.</small></div></div><div class="erp-card-body"><form class="erp-form" data-form="license-activate"><textarea class="form-control" name="key" placeholder="SKYBLUE_LICENSE_V1..." required></textarea><button class="btn btn-primary" type="submit">Activate</button></form></div></section><section class="erp-card"><div class="erp-card-head"><div><h2>Issue key</h2><small>Bind a new license to this machine.</small></div></div><div class="erp-card-body"><form class="erp-form" data-form="license-issue"><div class="erp-form-row"><input class="form-control" name="client" placeholder="Client name" required><input class="form-control" name="tin" placeholder="TIN (optional)"></div><input class="form-control" name="ttlDays" type="number" min="1" value="365" required><button class="btn btn-dark" type="submit">Generate key</button></form></div></section></div></div>';
  }

  function openIngredientCreate() {
    openModal('Add ingredient', '<form class="erp-form" data-form="ingredient"><div class="erp-form-row"><div><label class="form-label">Name</label><input class="form-control" name="name" required></div><div><label class="form-label">Unit</label><input class="form-control" name="unit" value="pcs"></div></div><div class="erp-form-row three"><div><label class="form-label">Current stock</label><input class="form-control" type="number" step="0.01" name="currentStock" value="0"></div><div><label class="form-label">Minimum stock</label><input class="form-control" type="number" step="0.01" name="minStock" value="0"></div><div><label class="form-label">Cost per unit</label><input class="form-control" type="number" step="0.01" name="costPerUnit" value="0"></div></div><button class="btn btn-primary" type="submit">Create ingredient</button></form>');
  }

  function openSupplierCreate() {
    openModal('Add supplier', '<form class="erp-form" data-form="supplier"><div class="erp-form-row"><div><label class="form-label">Name</label><input class="form-control" name="name" required></div><div><label class="form-label">Contact</label><input class="form-control" name="contactName"></div></div><div class="erp-form-row"><div><label class="form-label">Phone</label><input class="form-control" name="phone"></div><div><label class="form-label">Email</label><input class="form-control" name="email" type="email"></div></div><div><label class="form-label">Address</label><input class="form-control" name="address"></div><div class="erp-form-row"><div><label class="form-label">Tax number</label><input class="form-control" name="taxNumber"></div><div><label class="form-label">Notes</label><input class="form-control" name="notes"></div></div><button class="btn btn-primary" type="submit">Create supplier</button></form>');
  }

  function openCustomerCreate() {
    openModal('Add customer', '<form class="erp-form" data-form="customer"><div class="erp-form-row"><div><label class="form-label">Name</label><input class="form-control" name="name" required></div><div><label class="form-label">Phone</label><input class="form-control" name="phone"></div></div><div><label class="form-label">Email</label><input class="form-control" name="email" type="email"></div><div><label class="form-label">Address</label><input class="form-control" name="address"></div><div><label class="form-label">Tax number</label><input class="form-control" name="taxNumber"></div><div><label class="form-label">Notes</label><input class="form-control" name="notes"></div><button class="btn btn-primary" type="submit">Create customer</button></form>');
  }

  function openReservationCreate() {
    openModal('New reservation', '<form class="erp-form" data-form="reservation"><div class="erp-form-row"><div><label class="form-label">Guest name</label><input class="form-control" name="guestName" required></div><div><label class="form-label">Phone</label><input class="form-control" name="phone"></div></div><div class="erp-form-row"><div><label class="form-label">Party size</label><input class="form-control" type="number" min="1" name="partySize" value="2"></div><div><label class="form-label">Reserved at</label><input class="form-control" type="datetime-local" name="reservedAt" required></div></div><div><label class="form-label">Notes</label><textarea class="form-control" name="notes"></textarea></div><button class="btn btn-primary" type="submit">Book reservation</button></form>');
  }

  function openExpenseCreate() {
    openModal('Record expense', '<form class="erp-form" data-form="expense"><div class="erp-form-row"><div><label class="form-label">Category</label><input class="form-control" name="category" value="General" required></div><div><label class="form-label">Amount</label><input class="form-control" type="number" step="0.01" name="amount" required></div></div><div class="erp-form-row"><div><label class="form-label">Payment method</label><input class="form-control" name="paymentMethod" value="CASH"></div><div><label class="form-label">Reference</label><input class="form-control" name="reference"></div></div><div><label class="form-label">Note</label><textarea class="form-control" name="note"></textarea></div><button class="btn btn-primary" type="submit">Record expense</button></form>');
  }

  function openTableCreate() {
    openModal('Add table', '<form class="erp-form" data-form="table"><div class="erp-form-row"><div><label class="form-label">Table number</label><input class="form-control" name="number" required></div><div><label class="form-label">Name</label><input class="form-control" name="name"></div></div><div class="erp-form-row"><div><label class="form-label">Capacity</label><input class="form-control" type="number" min="1" name="capacity" value="4"></div><div><label class="form-label">Floor ID (optional)</label><input class="form-control" name="floorId"></div></div><button class="btn btn-primary" type="submit">Create table</button></form>');
  }

  function openFloorCreate() {
    openModal('Add floor', '<form class="erp-form" data-form="floor"><div><label class="form-label">Floor name</label><input class="form-control" name="name" required></div><button class="btn btn-primary" type="submit">Create floor</button></form>');
  }

  function openRecipeCreate() {
    const menu = JSON.parse((document.getElementById('menuItemsData') || {}).value || '[]');
    openModal('Add recipe', '<form class="erp-form" data-form="recipe"><div><label class="form-label">Menu item</label><select class="form-control" name="menuItemId" required><option value="">Select menu item</option>' + options(menu, 'id', 'name') + '</select></div><div><label class="form-label">Recipe name</label><input class="form-control" name="name" placeholder="Optional"></div><div><label class="form-label">Yield quantity</label><input class="form-control" type="number" step="0.01" name="yieldQty" value="1"></div><div><label class="form-label">Notes</label><textarea class="form-control" name="notes"></textarea></div><button class="btn btn-primary" type="submit">Save recipe</button></form>');
  }

  function openRecipeLine(recipeId) {
    const ingredients = JSON.parse((document.getElementById('ingredientsData') || {}).value || '[]');
    if (!ingredients.length) {
      showToast('Add an ingredient first');
      return;
    }
    openModal('Add recipe line', '<form class="erp-form" data-form="recipe-line" data-id="' + recipeId + '"><div><label class="form-label">Ingredient</label><select class="form-control" name="ingredientId" required><option value="">Select ingredient</option>' + options(ingredients, 'id', 'name') + '</select></div><div class="erp-form-row"><div><label class="form-label">Quantity</label><input class="form-control" type="number" step="0.001" name="quantity" required></div><div><label class="form-label">Unit</label><input class="form-control" name="unit" placeholder="Optional"></div></div><button class="btn btn-primary" type="submit">Add line</button></form>');
  }

  function openPurchaseCreate() {
    const suppliers = JSON.parse((document.getElementById('suppliersData') || {}).value || '[]');
    const ingredients = JSON.parse((document.getElementById('ingredientsData') || {}).value || '[]');
    openModal('New purchase order', '<form class="erp-form" data-form="purchase"><div class="erp-form-row"><div><label class="form-label">Supplier</label><select class="form-control" name="supplierId" required><option value="">Select supplier</option>' + options(suppliers, 'id', 'name') + '</select></div><div><label class="form-label">Expected at</label><input class="form-control" type="datetime-local" name="expectedAt"></div></div><div class="erp-form-row"><div><label class="form-label">Ingredient</label><select class="form-control" name="ingredientId" required><option value="">Select ingredient</option>' + options(ingredients, 'id', 'name') + '</select></div><div><label class="form-label">Description</label><input class="form-control" name="description" placeholder="Optional"></div></div><div class="erp-form-row"><div><label class="form-label">Quantity</label><input class="form-control" type="number" step="0.01" name="quantity" required></div><div><label class="form-label">Unit cost</label><input class="form-control" type="number" step="0.01" name="unitCost" required></div></div><div><label class="form-label">Notes</label><textarea class="form-control" name="notes"></textarea></div><button class="btn btn-primary" type="submit">Create purchase order</button></form>');
  }

  function openUserCreate() {
    const roles = JSON.parse((document.getElementById('rolesData') || {}).value || '[]');
    openModal('Add user', '<form class="erp-form" data-form="user-create"><div class="erp-form-row"><div><label class="form-label">Name</label><input class="form-control" name="name" required></div><div><label class="form-label">Email</label><input class="form-control" name="email" type="email" required></div></div><div class="erp-form-row"><div><label class="form-label">Phone</label><input class="form-control" name="phone"></div><div><label class="form-label">Password</label><input class="form-control" name="password" type="password" minlength="8" required></div></div><div><label class="form-label">Roles</label><div class="erp-form-row">' + roles.map(function (role) { return '<label class="erp-list-row"><input type="checkbox" name="roleIds" value="' + role.id + '"> ' + esc(role.name) + '</label>'; }).join('') + '</div></div><label class="erp-list-row"><input type="checkbox" name="isSuperAdmin"> Super administrator</label><button class="btn btn-primary" type="submit">Create user</button></form>');
  }

  function openUserEdit(id) {
    const roles = JSON.parse((document.getElementById('rolesData') || {}).value || '[]');
    api('/api/erp/users').then(function (data) {
      const user = data.users.find(function (item) { return String(item.id) === String(id); });
      if (!user) return showToast('User not found');
      const assigned = (user.roles || []).map(function (role) { return String(role.id); });
      openModal('Edit user', '<form class="erp-form" data-form="user-edit" data-id="' + user.id + '"><div class="erp-form-row"><div><label class="form-label">Name</label><input class="form-control" name="name" value="' + esc(user.name) + '" required></div><div><label class="form-label">Email</label><input class="form-control" name="email" value="' + esc(user.email) + '" required></div></div><div class="erp-form-row"><div><label class="form-label">Phone</label><input class="form-control" name="phone" value="' + esc(user.phone || '') + '"></div><div><label class="form-label">New password (optional)</label><input class="form-control" name="password" type="password" minlength="8"></div></div><div><label class="form-label">Roles</label><div class="erp-form-row">' + roles.map(function (role) { return '<label class="erp-list-row"><input type="checkbox" name="roleIds" value="' + role.id + '"' + (assigned.indexOf(String(role.id)) !== -1 ? ' checked' : '') + '> ' + esc(role.name) + '</label>'; }).join('') + '</div></div><label class="erp-list-row"><input type="checkbox" name="isSuperAdmin"' + (user.isSuperAdmin ? ' checked' : '') + '> Super administrator</label><button class="btn btn-primary" type="submit">Save user</button></form>');
    }).catch(showError);
  }

  function openRoleEdit(id) {
    const roles = JSON.parse((document.getElementById('rolesData') || {}).value || '[]');
    const permissions = JSON.parse((document.getElementById('permissionsData') || {}).value || '[]');
    const role = roles.find(function (item) { return String(item.id) === String(id); });
    if (!role) return showToast('Role not found');
    const assigned = role.permissions || [];
    const groups = {};
    permissions.forEach(function (permission) {
      groups[permission.module] = groups[permission.module] || [];
      groups[permission.module].push(permission);
    });
    openModal('Edit role: ' + role.name, '<form class="erp-form" data-form="role-permissions" data-id="' + role.id + '"><div class="erp-grid-2">' + Object.keys(groups).map(function (group) {
      return '<div><label class="form-label">' + esc(group) + '</label><div class="erp-list">' + groups[group].map(function (permission) {
        return '<label class="erp-list-row"><input type="checkbox" name="permissions" value="' + esc(permission.code) + '"' + (assigned.indexOf(permission.code) !== -1 ? ' checked' : '') + '> <span class="main"><b>' + esc(permission.name || permission.code) + '</b><small>' + esc(permission.code) + '</small></span></label>';
      }).join('') + '</div></div>';
    }).join('') + '</div><button class="btn btn-primary" type="submit">Save permissions</button></form>');
  }

  async function openOrderView(uuid) {
    try {
      const data = await api('/api/erp/orders/' + encodeURIComponent(uuid));
      const order = data.order;
      openModal('Order ' + order.orderNumber, '<div class="erp-grid-4"><div class="erp-card erp-stat"><span>Total</span><b>' + money(order.total) + '</b><small>Paid ' + money(order.paidTotal) + '</small></div><div class="erp-card erp-stat"><span>Status</span><b style="font-size:15px">' + esc(order.status) + '</b><small>' + esc(order.type) + '</small></div><div class="erp-card erp-stat"><span>Table</span><b>' + esc(order.tableNumber || '-') + '</b><small>' + esc(order.customerName || 'Walk-in') + '</small></div><div class="erp-card erp-stat"><span>Created</span><b style="font-size:12px">' + date(order.createdAt) + '</b><small>' + esc(order.guestCount) + ' guests</small></div></div>'
        + '<div class="erp-card" style="margin-top:12px"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Line total</th><th>Station</th><th>Status</th></tr></thead><tbody>' + order.items.map(function (item) { return '<tr><td><strong>' + esc(item.name) + '</strong></td><td>' + esc(item.quantity) + '</td><td>' + money(item.unitPrice) + '</td><td>' + money(item.lineTotal) + '</td><td>' + esc(item.station || '-') + '</td><td>' + statusTag(item.status) + '</td></tr>'; }).join('') + '</tbody></table></div></div>'
        + '<div class="erp-actions" style="margin-top:12px;justify-content:flex-start"><select class="soft-select" data-order-status data-id="' + esc(order.uuid) + '">' + ['SUBMITTED', 'PREPARING', 'READY', 'SERVED', 'PAID', 'COMPLETED', 'CANCELLED', 'VOID'].map(function (status) { return '<option value="' + status + '"' + (order.status === status ? ' selected' : '') + '>' + status + '</option>'; }).join('') + '</select><button class="btn btn-small btn-soft" data-action="order-invoice" data-id="' + esc(order.uuid) + '">Create invoice</button><button class="btn btn-small btn-outline" data-action="order-refund" data-id="' + esc(order.uuid) + '">Refund</button></div>');
    } catch (error) {
      showError(error);
    }
  }

  async function openPurchaseView(id) {
    try {
      const data = await api('/api/erp/purchases/' + id);
      const purchase = data.purchase;
      openModal('Purchase ' + purchase.poNumber, '<div class="erp-grid-3"><div class="erp-card erp-stat"><span>Supplier</span><b style="font-size:13px">' + esc(purchase.supplierName || '-') + '</b><small>' + esc(purchase.status) + '</small></div><div class="erp-card erp-stat"><span>Total</span><b>' + money(purchase.total) + '</b><small>Subtotal ' + money(purchase.subtotal) + '</small></div><div class="erp-card erp-stat"><span>Order date</span><b style="font-size:12px">' + date(purchase.orderDate) + '</b><small>Expected ' + shortDate(purchase.expectedAt) + '</small></div></div><div class="erp-card" style="margin-top:12px"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Item</th><th>Qty</th><th>Received</th><th>Unit cost</th><th>Line total</th></tr></thead><tbody>' + purchase.items.map(function (item) { return '<tr><td><strong>' + esc(item.ingredientName || item.description || '-') + '</strong></td><td>' + money(item.quantity) + ' ' + esc(item.unit || '') + '</td><td>' + money(item.receivedQty) + '</td><td>' + money(item.unitCost) + '</td><td>' + money(item.lineTotal) + '</td></tr>'; }).join('') + '</tbody></table></div></div><div class="erp-actions" style="margin-top:12px;justify-content:flex-start"><button class="btn btn-small btn-primary" data-action="purchase-receive" data-id="' + purchase.id + '">Receive all</button><button class="btn btn-small btn-outline" data-action="purchase-cancel" data-id="' + purchase.id + '">Cancel order</button></div>');
    } catch (error) {
      showError(error);
    }
  }

  async function openCustomerView(id) {
    try {
      const data = await api('/api/erp/customers/' + id);
      const customer = data.customer;
      openModal(customer.name, '<div class="erp-grid-3"><div class="erp-card erp-stat"><span>Visits</span><b>' + esc(customer.visits) + '</b><small>Total orders</small></div><div class="erp-card erp-stat"><span>Total spent</span><b>' + money(customer.totalSpent) + '</b><small>All time</small></div><div class="erp-card erp-stat"><span>Loyalty points</span><b>' + esc(customer.loyaltyPoints) + '</b><small>' + esc(customer.phone || '-') + '</small></div></div><div class="erp-card" style="margin-top:12px"><div class="erp-card-head"><div><h2>Reservations</h2><small>' + esc(customer.email || '') + '</small></div></div><div class="erp-card-body"><div class="erp-list">' + (data.reservations.length ? data.reservations.map(function (item) { return '<div class="erp-list-row"><div class="main"><b>' + date(item.reserved_at) + '</b><small>Party of ' + esc(item.party_size) + '</small></div>' + statusTag(item.status) + '</div>'; }).join('') : '<div class="erp-empty">No reservations.</div>') + '</div></div></div>');
    } catch (error) {
      showError(error);
    }
  }

  async function openInvoiceView(id) {
    try {
      const data = await api('/api/erp/invoices/' + id);
      const invoice = data.invoice;
      openModal('Invoice ' + invoice.invoiceNumber, '<div class="erp-grid-3"><div class="erp-card erp-stat"><span>Total</span><b>' + money(invoice.total) + '</b><small>Paid ' + money(invoice.paidTotal) + '</small></div><div class="erp-card erp-stat"><span>Status</span><b style="font-size:14px">' + esc(invoice.status) + '</b><small>' + esc(invoice.customerName || 'Walk-in') + '</small></div><div class="erp-card erp-stat"><span>Issued</span><b style="font-size:12px">' + date(invoice.issuedAt) + '</b><small>Order ' + esc(invoice.orderNumber || '-') + '</small></div></div><div class="erp-card" style="margin-top:12px"><div class="erp-table-card"><table class="erp-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody>' + invoice.items.map(function (item) { return '<tr><td><strong>' + esc(item.name) + '</strong></td><td>' + esc(item.quantity) + '</td><td>' + money(item.unitPrice) + '</td><td>' + money(item.lineTotal) + '</td></tr>'; }).join('') + '</tbody></table></div></div>');
    } catch (error) {
      showError(error);
    }
  }

  async function handleAction(action, button) {
    const id = button.dataset.id;
    if (action === 'refresh') return loadView(state.view, state.params);
    if (action === 'ingredient-create') return openIngredientCreate();
    if (action === 'supplier-create') return openSupplierCreate();
    if (action === 'customer-create') return openCustomerCreate();
    if (action === 'reservation-create') return openReservationCreate();
    if (action === 'expense-create') return openExpenseCreate();
    if (action === 'table-create') return openTableCreate();
    if (action === 'floor-create') return openFloorCreate();
    if (action === 'recipe-create') return openRecipeCreate();
    if (action === 'recipe-line-add') return openRecipeLine(id);
    if (action === 'purchase-create') return openPurchaseCreate();
    if (action === 'user-create') return openUserCreate();
    if (action === 'user-edit') return openUserEdit(id);
    if (action === 'role-edit') return openRoleEdit(id);
    if (action === 'menu-item-create') return openMenuItemForm(null);
    if (action === 'menu-item-edit') return openMenuItemForm(state.menuItems.find(function (item) { return String(item.id) === String(id); }));
    if (action === 'menu-category-create') return openMenuCategoryForm(null);
    if (action === 'menu-category-edit') return openMenuCategoryForm(state.menuCategories.find(function (category) { return String(category.id) === String(id); }));
    if (action === 'menu-item-delete') {
      if (!window.confirm('Delete this menu item?')) return;
      try {
        await api('/api/admin/menu/items/' + id, { method: 'DELETE' });
        showToast('Menu item deleted');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'menu-item-toggle') {
      const item = state.menuItems.find(function (entry) { return String(entry.id) === String(id); });
      if (!item) return;
      if (!item.categoryId) {
        showToast('Assign a category before changing availability');
        return;
      }
      const nextAvailable = item.available === false;
      try {
        await api('/api/admin/menu/items', {
          method: 'POST',
          body: JSON.stringify({
            id: item.id,
            categoryId: item.categoryId,
            name: item.name,
            price: item.price,
            description: item.desc || '',
            station: item.station || 'Kitchen',
            available: nextAvailable,
            soldOut: nextAvailable ? false : item.soldOut,
            featured: item.featured
          })
        });
        showToast(nextAvailable ? 'Menu item enabled' : 'Menu item disabled');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'print-test') {
      try {
        await api('/api/print/test', { method: 'POST', body: JSON.stringify({}) });
        showToast('Test print queued');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'print-process') {
      try {
        await api('/api/print/process', { method: 'POST', body: JSON.stringify({}) });
        showToast('Print queue processed');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'order-view') return openOrderView(id);
    if (action === 'purchase-view') return openPurchaseView(id);
    if (action === 'customer-view') return openCustomerView(id);
    if (action === 'invoice-view') return openInvoiceView(id);
    if (action === 'order-invoice') {
      try {
        const data = await api('/api/erp/orders/' + encodeURIComponent(id) + '/invoice', { method: 'POST', body: JSON.stringify({}) });
        showToast('Invoice ' + data.invoice.invoiceNumber + ' created');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'order-refund') {
      const amount = window.prompt('Refund amount');
      if (!amount) return;
      const reason = window.prompt('Refund reason') || 'Refund';
      try {
        await api('/api/erp/orders/' + encodeURIComponent(id) + '/refund', { method: 'POST', body: JSON.stringify({ amount: Number(amount), reason: reason }) });
        showToast('Refund recorded');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'purchase-receive') {
      if (!window.confirm('Receive all outstanding items for this purchase order?')) return;
      try {
        const data = await api('/api/erp/purchases/' + id + '/receive', { method: 'POST', body: JSON.stringify({}) });
        showToast('Purchase ' + data.status.toLowerCase());
        closeModal();
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'purchase-cancel') {
      if (!window.confirm('Cancel this purchase order?')) return;
      try {
        await api('/api/erp/purchases/' + id + '/cancel', { method: 'POST', body: JSON.stringify({}) });
        showToast('Purchase cancelled');
        closeModal();
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'supplier-toggle') {
      try {
        await api('/api/erp/suppliers/' + id + '/toggle', { method: 'POST', body: JSON.stringify({}) });
        showToast('Supplier updated');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'expense-delete') {
      if (!window.confirm('Delete this expense?')) return;
      try {
        await api('/api/erp/expenses/' + id, { method: 'DELETE' });
        showToast('Expense deleted');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'inventory-adjust') {
      const quantity = window.prompt('Adjustment quantity for ' + button.dataset.name + ' (' + button.dataset.unit + '). Use a negative number to reduce stock.', '0');
      if (!quantity) return;
      const notes = window.prompt('Reason for adjustment', 'Manual adjustment') || 'Manual adjustment';
      try {
        await api('/api/erp/inventory/adjust', { method: 'POST', body: JSON.stringify({ ingredientId: Number(id), quantity: Number(quantity), notes: notes }) });
        showToast('Stock adjusted');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'recipe-line-delete') {
      if (!window.confirm('Remove this ingredient line?')) return;
      try {
        await api('/api/erp/recipes/lines/' + id, { method: 'DELETE' });
        showToast('Recipe line removed');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'user-toggle') {
      try {
        await api('/api/erp/users/' + id + '/toggle', { method: 'POST', body: JSON.stringify({}) });
        showToast('User updated');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'invoice-pay') {
      const amount = window.prompt('Payment amount');
      if (!amount) return;
      try {
        await api('/api/erp/invoices/' + id + '/pay', { method: 'POST', body: JSON.stringify({ amount: Number(amount) }) });
        showToast('Payment recorded');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'invoice-void') {
      if (!window.confirm('Void this invoice?')) return;
      try {
        await api('/api/erp/invoices/' + id + '/void', { method: 'POST', body: JSON.stringify({}) });
        showToast('Invoice voided');
        loadView(state.view, state.params);
      } catch (error) { showError(error); }
    }
  }

  function formValues(form) {
    const values = {};
    Array.from(form.elements).forEach(function (element) {
      if (!element.name || element.disabled) return;
      if (element.type === 'checkbox') {
        if (element.name === 'roleIds' || element.name === 'permissions') return;
        values[element.name] = element.checked;
      } else {
        values[element.name] = element.value;
      }
    });
    values.roleIds = Array.from(form.querySelectorAll('input[name="roleIds"]:checked')).map(function (input) { return Number(input.value); });
    values.permissions = Array.from(form.querySelectorAll('input[name="permissions"]:checked')).map(function (input) { return input.value; });
    return values;
  }

  async function handleForm(event) {
    const form = event.target;
    if (!form.dataset || !form.dataset.form) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const original = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Saving...';
    }
    const values = formValues(form);
    const id = form.dataset.id;
    try {
      if (form.dataset.form === 'ingredient') {
        await api('/api/erp/inventory/ingredients', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'supplier') {
        await api('/api/erp/suppliers', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'customer') {
        await api('/api/erp/customers', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'reservation') {
        await api('/api/erp/reservations', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'expense') {
        await api('/api/erp/expenses', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'table') {
        await api('/api/erp/tables', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'floor') {
        await api('/api/erp/floors', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'recipe') {
        await api('/api/erp/recipes', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'recipe-line') {
        await api('/api/erp/recipes/' + id + '/lines', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'menu-item') {
        await api('/api/admin/menu/items', {
          method: 'POST',
          body: JSON.stringify({
            id: values.id ? Number(values.id) : undefined,
            categoryId: Number(values.categoryId),
            name: values.name,
            price: Number(values.price),
            description: values.description,
            station: values.station,
            available: values.available,
            soldOut: values.soldOut,
            featured: values.featured
          })
        });
      } else if (form.dataset.form === 'menu-category') {
        await api('/api/admin/menu/categories', {
          method: 'POST',
          body: JSON.stringify({
            id: values.id ? Number(values.id) : undefined,
            name: values.name,
            sort: Number(values.sort || 0)
          })
        });
      } else if (form.dataset.form === 'purchase') {
        await api('/api/erp/purchases', {
          method: 'POST',
          body: JSON.stringify({
            supplierId: Number(values.supplierId),
            expectedAt: values.expectedAt || null,
            notes: values.notes,
            items: [{ ingredientId: Number(values.ingredientId), description: values.description, quantity: Number(values.quantity), unitCost: Number(values.unitCost) }]
          })
        });
      } else if (form.dataset.form === 'user-create') {
        await api('/api/erp/users', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'user-edit') {
        await api('/api/erp/users/' + id, { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'role-permissions') {
        await api('/api/erp/roles/' + id + '/permissions', { method: 'POST', body: JSON.stringify({ permissions: values.permissions }) });
      } else if (form.dataset.form === 'settings') {
        await api('/api/erp/settings', { method: 'POST', body: JSON.stringify(values) });
      } else if (form.dataset.form === 'license-activate') {
        const data = await api('/api/erp/license/activate', { method: 'POST', body: JSON.stringify({ key: values.key }) });
        showToast('License activated until ' + date(data.expiresAt));
      } else if (form.dataset.form === 'license-issue') {
        const data = await api('/api/erp/license/issue', { method: 'POST', body: JSON.stringify({ client: values.client, tin: values.tin, ttlDays: Number(values.ttlDays) }) });
        openModal('License key generated', '<div class="erp-license-key">' + esc(data.key) + '</div><button class="btn btn-small btn-outline" type="button" data-action="copy-license" data-id="' + esc(data.key) + '">Copy key</button>');
        showToast('License key generated');
        return;
      }
      closeModal();
      showToast('Saved successfully');
      loadView(state.view, state.params);
    } catch (error) {
      showError(error);
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target.matches('[data-filter-status]')) {
      loadView('orders', { status: target.value });
      return;
    }
    if (target.matches('[data-order-status]')) {
      api('/api/erp/orders/' + encodeURIComponent(target.dataset.id) + '/status', { method: 'POST', body: JSON.stringify({ status: target.value }) })
        .then(function () { showToast('Order status updated'); loadView(state.view, state.params); })
        .catch(showError);
      return;
    }
    if (target.matches('[data-table-status]')) {
      api('/api/erp/tables/' + target.dataset.id + '/status', { method: 'POST', body: JSON.stringify({ status: target.value }) })
        .then(function () { showToast('Table status updated'); loadView(state.view, state.params); })
        .catch(showError);
      return;
    }
    if (target.matches('[data-reservation-status]')) {
      api('/api/erp/reservations/' + target.dataset.id + '/status', { method: 'POST', body: JSON.stringify({ status: target.value }) })
        .then(function () { showToast('Reservation updated'); loadView(state.view, state.params); })
        .catch(showError);
    }
  }

  function handleClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    event.preventDefault();
    if (target.dataset.action === 'copy-license') {
      navigator.clipboard.writeText(target.dataset.id).then(function () { showToast('License key copied'); });
      return;
    }
    handleAction(target.dataset.action, target);
  }

  async function init() {
    try {
      const data = await api('/api/auth/me');
      state.me = data.user;
      state.permissions = data.permissions || [];
      state.roles = (data.roles || []);
      renderProfile();
      renderNav();
      const hash = window.location.hash.replace('#', '') || 'dashboard';
      loadView(hash);
    } catch (error) {
      if (error.status === 401) {
        window.location.replace('/login?next=/erp');
        return;
      }
      viewContent.innerHTML = pageHead('Unable to start ERP', '') + '<div class="erp-card"><div class="erp-empty">' + esc(error.message) + '</div></div>';
    }
  }

  document.getElementById('menuToggle').addEventListener('click', function () {
    sidebar.classList.toggle('open');
    scrim.classList.toggle('open');
  });
  scrim.addEventListener('click', closeSidebar);
  var logoutBtn = document.getElementById('logoutButton');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function () {
      try {
        await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
      } catch (error) {}
      window.location.replace('/login');
    });
  }
  modalLayer.addEventListener('click', function (event) {
    if (event.target === modalLayer || event.target.id === 'modalClose') closeModal();
  });
  navGroups.addEventListener('click', function (event) {
    const link = event.target.closest('[data-view]');
    if (!link) return;
    closeSidebar();
  });
  window.addEventListener('hashchange', function () {
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    if (hash !== state.view) loadView(hash);
  });
  viewContent.addEventListener('click', handleClick);
  viewContent.addEventListener('submit', handleForm);
  viewContent.addEventListener('change', handleChange);
  modalLayer.addEventListener('click', handleClick);
  modalLayer.addEventListener('submit', handleForm);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeModal();
  });

  init();
})();
