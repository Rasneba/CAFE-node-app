(() => {
  const state = {
    report: null,
    requestId: 0,
    criteria: presetRange('this-month'),
  };

  function icon(name) {
    return `<i data-lucide="${name}" aria-hidden="true"></i>`;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function money(value, currency) {
    const amount = Number(value);
    return `${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0)} ${esc(currency)}`;
  }

  function integer(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value) || 0);
  }

  function humanize(value) {
    return esc(String(value || '—').toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()));
  }

  function formatDate(value, short = false) {
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return esc(value);
    return new Intl.DateTimeFormat('en-GB', short
      ? { day: '2-digit', month: 'short' }
      : { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  function formatClosedAt(value) {
    const [date, time = ''] = String(value).split('T');
    return `<span class="report-order-time">${formatDate(date, true)}<small>${esc(time.slice(0, 5))}</small></span>`;
  }

  function toInputDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function fromInputDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function shiftDays(date, amount) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + amount);
    return copy;
  }

  function presetRange(preset) {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    let from = new Date(today);
    let to = new Date(today);

    if (preset === 'yesterday') {
      from = shiftDays(today, -1);
      to = shiftDays(today, -1);
    } else if (preset === 'this-week' || preset === 'last-week') {
      const daysSinceMonday = (today.getDay() + 6) % 7;
      from = shiftDays(today, -daysSinceMonday);
      if (preset === 'last-week') {
        from = shiftDays(from, -7);
        to = shiftDays(from, 6);
      }
    } else if (preset === 'this-month') {
      from = new Date(today.getFullYear(), today.getMonth(), 1, 12);
    } else if (preset === 'last-month') {
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1, 12);
      to = new Date(today.getFullYear(), today.getMonth(), 0, 12);
    } else if (preset === 'last-30-days') {
      from = shiftDays(today, -29);
    }

    return { from: toInputDate(from), to: toInputDate(to) };
  }

  function render() {
    const { from, to } = state.criteria;
    setTimeout(() => {
      bind();
      loadReport();
    }, 0);

    return `
      <div class="page-heading report-page-heading">
        <div>
          <div class="eyebrow">REPORTS · RESTAURANT REPORT</div>
          <h1>Restaurant Sales Report</h1>
          <p>Collections, paid orders and operating performance in one clear report.</p>
        </div>
        <div class="heading-actions no-print">
          <button class="btn btn-outline" id="exportReport" type="button" disabled>${icon('download')} Export CSV</button>
          <button class="btn btn-primary" id="printReport" type="button" disabled>${icon('printer')} Print</button>
        </div>
      </div>
      <div class="report-layout">
        <aside class="surface report-directory no-print" aria-label="Restaurant Report List">
          <div class="report-directory-head">
            <span>${icon('library-big')}</span>
            <div><b>Restaurant Report List</b><small>Financial & operational reporting</small></div>
          </div>
          <div class="report-directory-body">
            <div class="report-group-label">REPORT TYPES</div>
            <div class="report-group-name">Restaurant Report <span>1</span></div>
            <button class="report-type active" type="button" aria-current="page">
              ${icon('chart-no-axes-column-increasing')}
              <span><b>Restaurant Sales Report</b><small>Sales, payments, items & expenses</small></span>
            </button>
          </div>
          <div class="report-directory-foot">
            <div class="report-source">${icon('database')}<span id="reportSource">Preparing data source…</span></div>
            <p>All amounts are calculated from records in the selected date range.</p>
          </div>
        </aside>
        <section class="report-workspace" aria-label="Restaurant Sales Report workspace">
          <form class="surface report-criteria no-print" id="reportCriteria">
            <div class="report-criteria-head">
              <div>${icon('list-filter')}<h2>Report Criteria</h2></div>
              <span>Choose a period, then run the report</span>
            </div>
            <div class="criteria-fields">
              <div class="criteria-field">
                <label for="reportPreset">Date Criteria</label>
                <select id="reportPreset" name="preset">
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="this-week">This week</option>
                  <option value="last-week">Last week</option>
                  <option value="this-month" selected>This month</option>
                  <option value="last-month">Last month</option>
                  <option value="last-30-days">Last 30 days</option>
                  <option value="custom">Custom range</option>
                </select>
              </div>
              <div class="criteria-field"><label for="reportFrom">From date</label><input id="reportFrom" name="from" type="date" value="${esc(from)}" required></div>
              <div class="criteria-field"><label for="reportTo">To date</label><input id="reportTo" name="to" type="date" value="${esc(to)}" required></div>
              <button class="btn btn-primary criteria-submit" id="runReport" type="submit">${icon('play')} Run report</button>
            </div>
          </form>
          <div id="reportStatus" aria-live="polite" class="report-sr-only"></div>
          <div id="reportOutput" aria-busy="true">${loadingTemplate()}</div>
        </section>
      </div>`;
  }

  function bind() {
    const form = document.getElementById('reportCriteria');
    if (!form) return;
    const preset = document.getElementById('reportPreset');
    const from = document.getElementById('reportFrom');
    const to = document.getElementById('reportTo');

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      loadReport();
    });
    preset.addEventListener('change', () => {
      if (preset.value === 'custom') return;
      const range = presetRange(preset.value);
      from.value = range.from;
      to.value = range.to;
    });
    for (const input of [from, to]) {
      input.addEventListener('change', () => { preset.value = 'custom'; });
    }
    document.getElementById('printReport').addEventListener('click', () => {
      if (state.report) window.print();
    });
    document.getElementById('exportReport').addEventListener('click', exportCsv);
  }

  function loadingTemplate() {
    return `<div class="surface report-loading"><div><div class="report-loading-spinner"></div><b>Running restaurant sales report</b><p>Reading collections, orders and expenses…</p></div></div>`;
  }

  function errorTemplate(message) {
    return `<div class="surface report-error"><div><span class="report-error-icon">${icon('cloud-off')}</span><h2>We couldn’t run this report</h2><p>${esc(message)}</p><button class="btn btn-primary" id="retryReport" type="button">${icon('rotate-cw')} Try again</button></div></div>`;
  }

  function setBusy(busy) {
    const run = document.getElementById('runReport');
    const exportButton = document.getElementById('exportReport');
    const printButton = document.getElementById('printReport');
    const output = document.getElementById('reportOutput');
    if (run) {
      run.disabled = busy;
      run.innerHTML = busy ? `${icon('loader-circle')} Running…` : `${icon('play')} Run report`;
    }
    if (exportButton) exportButton.disabled = busy || !state.report;
    if (printButton) printButton.disabled = busy || !state.report;
    if (output) output.setAttribute('aria-busy', String(busy));
    drawIcons();
  }

  function setStatus(message) {
    const status = document.getElementById('reportStatus');
    if (status) status.textContent = message;
  }

  async function loadReport() {
    const fromInput = document.getElementById('reportFrom');
    const toInput = document.getElementById('reportTo');
    const output = document.getElementById('reportOutput');
    if (!fromInput || !toInput || !output) return;

    const from = fromInput.value;
    const to = toInput.value;
    if (from && to && from > to) {
      state.report = null;
      output.innerHTML = errorTemplate('The start date must be on or before the end date.');
      bindRetry();
      setBusy(false);
      return;
    }

    state.criteria = { from, to };
    state.report = null;
    const requestId = ++state.requestId;
    setBusy(true);
    setStatus('Running report.');
    output.innerHTML = loadingTemplate();
    const source = document.getElementById('reportSource');
    if (source) source.textContent = 'Reading report data…';

    try {
      const params = new URLSearchParams({ from, to });
      const response = await fetch(`/api/reports/restaurant-sales?${params}`, {
        headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || `Report request failed (${response.status}).`);
      if (requestId !== state.requestId || !document.getElementById('reportOutput')) return;

      state.report = body;
      document.getElementById('reportOutput').innerHTML = reportTemplate(body);
      if (source) source.textContent = body.meta.dataMode === 'demo' ? 'Local demo data' : 'PostgreSQL connected';
      setStatus(`Report ready. ${body.summary.orders} paid orders found.`);
      setBusy(false);
      drawIcons();
    } catch (error) {
      if (requestId !== state.requestId || !document.getElementById('reportOutput')) return;
      document.getElementById('reportOutput').innerHTML = errorTemplate(error.message);
      if (source) source.textContent = 'Data source unavailable';
      setStatus('Report failed.');
      setBusy(false);
      bindRetry();
      drawIcons();
    }
  }

  function bindRetry() {
    document.getElementById('retryReport')?.addEventListener('click', loadReport);
  }

  function reportTemplate(report) {
    const { summary: s, meta, criteria } = report;
    const currency = meta.currency;
    const isDemo = meta.dataMode === 'demo';
    const metrics = [
      ['GROSS COLLECTIONS', money(s.grossSales, currency), `${integer(s.paymentCount)} payments received`, 'wallet-cards'],
      ['NET COLLECTIONS', money(s.netSales, currency), `${money(s.refunds, currency)} refunds`, 'badge-dollar-sign'],
      ['PAID ORDERS', integer(s.orders), `${money(s.orderSales, currency)} order value`, 'receipt-text'],
      ['AVG. ORDER VALUE', money(s.averageOrderValue, currency), `Across ${integer(s.orders)} paid orders`, 'calculator'],
    ];
    const secondary = [
      ['Paid order value', money(s.orderSales, currency), ''],
      ['Tax collected', money(s.tax, currency), ''],
      ['Service charge', money(s.serviceCharge, currency), ''],
      ['Discounts', money(s.discounts, currency), ''],
      ['Expenses', money(s.expenses, currency), ''],
      ['Operating result', money(s.operatingResult, currency), s.operatingResult >= 0 ? 'positive' : 'negative'],
    ];

    return `
      <div class="report-print-title"><h1>Maison Addis · Restaurant Sales Report</h1><p>${formatDate(criteria.from)} – ${formatDate(criteria.to)} · ${esc(meta.timeZone)}</p></div>
      <div class="report-data-note ${isDemo ? 'demo' : ''} no-print">
        ${icon(isDemo ? 'flask-conical' : 'database-zap')}
        <span><b>${esc(meta.sourceLabel)}.</b> ${isDemo ? 'Set DATABASE_URL and run the Neon migration to replace these figures with your restaurant data.' : 'Figures are calculated directly from your database.'}</span>
      </div>
      <div class="report-metrics">
        ${metrics.map(([label, value, foot, ico]) => `<div class="surface report-metric"><div class="report-metric-top"><span class="stat-label">${label}</span><span>${icon(ico)}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`).join('')}
      </div>
      <div class="surface report-secondary">
        ${secondary.map(([label, value, className]) => `<div class="report-secondary-item"><span>${label}</span><b class="${className}">${value}</b></div>`).join('')}
      </div>
      <div class="report-two-col">
        ${dailyChart(report.daily, currency)}
        <section class="surface">
          <div class="surface-head"><div><div class="surface-title">Payment methods</div><div class="surface-sub">Share of gross collections</div></div>${icon('wallet-cards')}</div>
          <div class="report-payment-list">${paymentMethods(report.paymentMethods, currency)}</div>
        </section>
      </div>
      <div class="report-two-col">
        ${topItems(report.topItems, currency)}
        <div class="report-side-stack">
          ${expenseCategories(report.expenseCategories, currency, s.expenses)}
          ${orderChannels(report.orderChannels, currency)}
        </div>
      </div>
      ${ordersTable(report, currency)}
      <div class="report-footer"><span>Generated ${esc(new Date(meta.generatedAt).toLocaleString())} · ${esc(meta.timeZone)} · ${esc(currency)}</span><span>Collections are payment-based. Order metrics include PAID orders closed in this period.</span></div>`;
  }

  function dailyChart(days, currency) {
    const maximum = Math.max(0, ...days.map((day) => Number(day.grossSales) || 0));
    const highest = days.findIndex((day) => Number(day.grossSales) === maximum && maximum > 0);
    const bars = days.map((day, index) => {
      const value = Number(day.grossSales) || 0;
      const height = maximum > 0 ? Math.max(value > 0 ? 4 : 1, (value / maximum) * 100) : 1;
      const label = days.length > 16 ? day.date.slice(8, 10) : formatDate(day.date, true);
      const description = `${day.date}: ${money(day.grossSales, currency)} gross, ${money(day.refunds, currency)} refunds, ${integer(day.orders)} paid orders`;
      return `<div class="report-day-bar ${index === highest ? 'highest' : ''}" title="${esc(description)}" aria-label="${esc(description)}"><div class="report-bar-track"><div class="report-bar-fill" style="height:${height.toFixed(2)}%"></div></div><span class="report-day-label">${label}</span></div>`;
    }).join('');

    return `<section class="surface report-chart"><div class="surface-head"><div><div class="surface-title">Daily collections</div><div class="surface-sub">${integer(days.length)} active days · hover a bar for details</div></div><span class="pill green">${money(maximum, currency)} peak</span></div><div class="report-chart-scroll">${days.length ? `<div class="report-bars" role="img" aria-label="Daily gross collections bar chart" style="grid-template-columns:repeat(${days.length},minmax(30px,1fr));width:100%;min-width:${days.length * 38}px">${bars}</div>` : '<div class="report-chart-empty">No collection activity in this period.</div>'}</div></section>`;
  }

  function paymentMethods(methods, currency) {
    if (!methods.length) return '<div class="report-empty-small">No payments recorded in this period.</div>';
    return methods.map((method) => `<div class="report-payment-row"><div class="report-payment-pair"><span><b>${esc(method.name)}</b><small>${integer(method.transactions)} payments · ${Number(method.share).toFixed(1)}%</small></span><strong>${money(method.total, currency)}</strong></div><div class="report-mix-track"><div class="report-mix-fill" style="width:${Math.max(0, Math.min(100, Number(method.share) || 0))}%"></div></div></div>`).join('');
  }

  function topItems(items, currency) {
    return `<section class="surface"><div class="surface-head"><div><div class="surface-title">Top selling items</div><div class="surface-sub">Paid orders · cancelled items excluded</div></div><span class="section-label">TOP ${integer(items.length)}</span></div><div class="table-scroll"><table class="data-table report-items-table"><caption class="report-sr-only">Top selling items</caption><thead><tr><th>#</th><th>ITEM</th><th>QUANTITY</th><th>REVENUE</th></tr></thead><tbody>${items.length ? items.map((item, index) => `<tr><td>${index + 1}</td><td><div class="report-item-name"><span class="report-item-rank">${index + 1}</span><span><b>${esc(item.name)}</b><small>${esc(item.category)}</small></span></div></td><td>${integer(item.quantity)}</td><td><strong>${money(item.revenue, currency)}</strong></td></tr>`).join('') : '<tr><td colspan="4"><div class="report-empty-small">No item sales in this period.</div></td></tr>'}</tbody></table></div></section>`;
  }

  function expenseCategories(categories, currency, totalExpenses) {
    return `<section class="surface"><div class="surface-head"><div><div class="surface-title">Expenses by category</div><div class="surface-sub">${money(totalExpenses, currency)} total</div></div>${icon('receipt')}</div>${categories.length ? categories.map((category) => {
      const share = totalExpenses > 0 ? (category.total / totalExpenses) * 100 : 0;
      return `<div class="report-expense-row"><div><b>${esc(category.category)}</b><strong>${money(category.total, currency)}</strong></div><small>${integer(category.entries)} entries</small><div class="report-mix-track"><div class="report-mix-fill" style="width:${Math.min(100, share)}%"></div></div></div>`;
    }).join('') : '<div class="report-empty-small">No expenses in this period.</div>'}</section>`;
  }

  function orderChannels(channels, currency) {
    return `<section class="surface"><div class="surface-head"><div><div class="surface-title">Order channels</div><div class="surface-sub">Paid order value by source</div></div>${icon('waypoints')}</div>${channels.length ? channels.map((channel) => `<div class="report-channel"><span class="pill gray">${humanize(channel.source)}</span><span>${integer(channel.orders)} orders</span><strong>${money(channel.value, currency)}</strong></div>`).join('') : '<div class="report-empty-small">No paid orders in this period.</div>'}</section>`;
  }

  function ordersTable(report, currency) {
    const rows = report.orders.map((order) => `<tr><td><span class="report-order-number">${esc(order.orderNumber)}</span></td><td>${formatClosedAt(order.closedAt)}</td><td><b>${humanize(order.source)}</b><small class="report-method-text" style="display:block;margin-top:3px">${humanize(order.type)}</small></td><td>${integer(order.itemCount)}</td><td>${money(order.subtotal, currency)}</td><td>${money(Number(order.tax) + Number(order.serviceCharge), currency)}</td><td>${money(order.discounts, currency)}</td><td><strong>${money(order.total, currency)}</strong>${Number(order.paidTotal) !== Number(order.total) ? `<small class="report-method-text" style="display:block;margin-top:3px">Paid ${money(order.paidTotal, currency)}</small>` : ''}</td><td><span class="pill green">Paid</span><small class="report-method-text" style="display:block;margin-top:4px">${esc(order.paymentMethods.join(' / ') || '—')}</small></td></tr>`).join('');
    const truncated = report.orders.length < report.summary.orders;

    return `<section class="surface report-orders"><div class="surface-head"><div><div class="surface-title">Paid order details</div><div class="surface-sub">Latest ${integer(report.orders.length)} of ${integer(report.summary.orders)} orders · ${formatDate(report.criteria.from)} – ${formatDate(report.criteria.to)}</div></div><span class="pill ${report.summary.orders ? 'green' : 'gray'}">${integer(report.summary.orders)} orders</span></div><div class="table-scroll"><table class="data-table"><caption class="report-sr-only">Paid orders in the selected report period</caption><thead><tr><th>ORDER</th><th>CLOSED</th><th>CHANNEL / TYPE</th><th>ITEMS</th><th>SUBTOTAL</th><th>TAX + SERVICE</th><th>DISCOUNT</th><th>TOTAL</th><th>PAYMENT</th></tr></thead><tbody>${rows || `<tr><td colspan="9"><div class="report-table-empty">${icon('receipt-text')}<b>No paid orders found</b><p>Try another date range or record a paid order.</p></div></td></tr>`}</tbody></table></div>${truncated ? `<div class="report-table-note">Only the latest ${integer(report.orders.length)} orders are shown. Narrow the date range for complete details and CSV export.</div>` : ''}</section>`;
  }

  async function exportCsv() {
    if (!state.report) return;
    const button = document.getElementById('exportReport');
    const { from, to } = state.report.criteria;
    if (button) button.disabled = true;

    try {
      const response = await fetch(`/api/reports/restaurant-sales/export?${new URLSearchParams({ from, to })}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || 'CSV export failed. Please try again.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `restaurant-sales-${from}-to-${to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('Restaurant sales CSV downloaded');
    } catch (error) {
      notify(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function notify(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
  }

  function drawIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  window.RestaurantReports = { render };
})();
