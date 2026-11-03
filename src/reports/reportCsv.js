function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  // Prevent user-controlled values from becoming spreadsheet formulas.
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function row(values) {
  return `${values.map(cell).join(',')}\r\n`;
}

function restaurantSalesCsv(report) {
  const { summary, criteria, meta } = report;
  let csv = row(['Restaurant Sales Report']);
  csv += row(['From', criteria.from, 'To', criteria.to]);
  csv += row(['Generated', meta.generatedAt, 'Currency', meta.currency, 'Data source', meta.sourceLabel]);
  csv += row([]);
  csv += row(['SUMMARY']);
  csv += row(['Metric', 'Value']);
  for (const [label, value] of [
    ['Gross collections', summary.grossSales],
    ['Refunds', summary.refunds],
    ['Net collections', summary.netSales],
    ['Expenses', summary.expenses],
    ['Operating result', summary.operatingResult],
    ['Paid orders', summary.orders],
    ['Paid order value', summary.orderSales],
    ['Average order value', summary.averageOrderValue],
    ['Tax collected', summary.tax],
    ['Service charge', summary.serviceCharge],
    ['Discounts', summary.discounts],
  ]) csv += row([label, value]);

  csv += row([]);
  csv += row(['DAILY ACTIVITY']);
  csv += row(['Date', 'Paid orders', 'Gross collections', 'Refunds', 'Net collections']);
  for (const day of report.daily) {
    csv += row([day.date, day.orders, day.grossSales, day.refunds, day.netSales]);
  }

  csv += row([]);
  csv += row(['PAID ORDERS']);
  csv += row(['Order number', 'Closed at', 'Channel', 'Order type', 'Items', 'Subtotal', 'Discounts', 'Tax', 'Service charge', 'Total', 'Paid', 'Payment methods']);
  for (const order of report.orders) {
    csv += row([
      order.orderNumber,
      order.closedAt,
      order.source,
      order.type,
      order.itemCount,
      order.subtotal,
      order.discounts,
      order.tax,
      order.serviceCharge,
      order.total,
      order.paidTotal,
      order.paymentMethods.join(' / '),
    ]);
  }

  if (report.orders.length < summary.orders) {
    csv += row([]);
    csv += row([`Only the latest ${report.orders.length} of ${summary.orders} orders are included. Narrow the date range for a complete order export.`]);
  }

  return `\uFEFF${csv}`;
}

module.exports = { cell, restaurantSalesCsv };
