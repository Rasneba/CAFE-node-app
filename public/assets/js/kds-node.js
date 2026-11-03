(function () {
  const board = document.getElementById('kdsBoard');
  const toast = document.getElementById('kdsToast');
  const clock = document.getElementById('kdsClock');
  const title = document.getElementById('kdsTitle');
  const subtitle = document.getElementById('kdsSubtitle');
  const pathStation = window.location.pathname.indexOf('/bar') === 0 ? 'BAR' : null;
  const station = String(new URLSearchParams(window.location.search).get('station') || pathStation || document.body.dataset.station || 'KITCHEN').toUpperCase() === 'BAR' ? 'BAR' : 'KITCHEN';
  const columns = [
    { status: 'PENDING', label: 'New tickets' },
    { status: 'PREPARING', label: 'In preparation' },
    { status: 'READY', label: 'Ready to serve' }
  ];
  let timer = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character];
    });
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(function () { toast.classList.remove('show'); }, 2400);
  }

  function timeAgo(value) {
    if (!value) return '-';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return seconds + 's ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    return Math.floor(minutes / 60) + 'h ago';
  }

  function stationMatches(item) {
    const value = String(item.station || '').toLowerCase();
    if (station === 'BAR') return value.indexOf('bar') !== -1;
    return value.indexOf('bar') === -1;
  }

  function ticket(order, status) {
    const items = order.items.filter(function (item) {
      return item.status === status && stationMatches(item);
    });
    if (!items.length) return '';
    const next = status === 'PENDING' ? 'PREPARING' : status === 'PREPARING' ? 'READY' : 'SERVED';
    const label = status === 'PENDING' ? 'Start' : status === 'PREPARING' ? 'Mark ready' : 'Served';
    const tone = status === 'PENDING' ? 'primary' : status === 'PREPARING' ? 'warn' : 'primary';
    return '<article class="kds-ticket">'
      + '<div class="kds-ticket-head"><div><strong>' + esc(order.orderNumber) + '</strong><small>' + esc(order.customerName || order.type || 'Walk-in') + ' · ' + timeAgo(order.createdAt) + '</small></div><span class="kds-table">' + esc(order.tableNumber ? 'Table ' + order.tableNumber : 'Takeaway') + '</span></div>'
      + '<div class="kds-items">' + items.map(function (item) {
        return '<div class="kds-item"><div class="kds-item-main"><b>' + esc(item.name) + '</b>' + (item.notes ? '<small>' + esc(item.notes) + '</small>' : '') + '</div><span class="kds-qty">x' + esc(item.quantity) + '</span></div>';
      }).join('') + '</div>'
      + '<div class="kds-actions">' + items.map(function (item) {
        return '<button class="' + tone + '" type="button" data-item="' + esc(item.uuid) + '" data-status="' + next + '">' + label + ' · ' + esc(item.name) + '</button>';
      }).join('') + '</div>'
      + '</article>';
  }

  function render(orders) {
    const html = columns.map(function (column) {
      const tickets = orders.map(function (order) { return ticket(order, column.status); }).join('');
      const count = orders.reduce(function (total, order) {
        return total + order.items.filter(function (item) { return item.status === column.status && stationMatches(item); }).length;
      }, 0);
      return '<section class="kds-column" data-status="' + column.status + '"><div class="kds-column-head"><h2>' + column.label + '</h2><span class="kds-count">' + count + '</span></div>' + (tickets || '<div class="kds-empty">No tickets</div>') + '</section>';
    }).join('');
    board.innerHTML = html;
  }

  async function load() {
    try {
      const response = await fetch('/api/kitchen', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) {
        window.location.replace('/login?next=' + encodeURIComponent(window.location.pathname));
        return;
      }
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error((data.error && data.error.message) || 'Unable to load tickets');
      render(data.orders || []);
    } catch (error) {
      board.innerHTML = '<div class="kds-empty">' + esc(error.message) + '</div>';
    }
  }

  async function updateStatus(button) {
    button.disabled = true;
    try {
      const response = await fetch('/api/kitchen/items/' + encodeURIComponent(button.dataset.item) + '/status', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: button.dataset.status })
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error((data.error && data.error.message) || 'Unable to update item');
      notify('Ticket updated');
      load();
    } catch (error) {
      notify(error.message);
      button.disabled = false;
    }
  }

  function tick() {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  title.textContent = station === 'BAR' ? 'Bar Display' : 'Kitchen Display';
  subtitle.textContent = station === 'BAR' ? 'Live drink tickets from the POS' : 'Live food tickets from the POS';
  document.title = (station === 'BAR' ? 'Bar Display' : 'Kitchen Display') + ' | Maison';
  document.body.dataset.station = station;
  document.querySelectorAll('[data-station-link]').forEach(function (link) {
    link.classList.toggle('active', link.dataset.stationLink === station);
  });

  board.addEventListener('click', function (event) {
    const button = event.target.closest('[data-item]');
    if (button) updateStatus(button);
  });
  document.getElementById('kdsRefresh').addEventListener('click', load);

  tick();
  setInterval(tick, 1000);
  load();
  timer = setInterval(load, 10000);
  window.addEventListener('beforeunload', function () { clearInterval(timer); });
})();
