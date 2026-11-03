const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init: Buffer.from([ESC, 0x40]),
  alignLeft: Buffer.from([ESC, 0x61, 0x00]),
  alignCenter: Buffer.from([ESC, 0x61, 0x01]),
  boldOn: Buffer.from([ESC, 0x45, 0x01]),
  boldOff: Buffer.from([ESC, 0x45, 0x00]),
  doubleOn: Buffer.from([GS, 0x21, 0x11]),
  doubleOff: Buffer.from([GS, 0x21, 0x00]),
  feed: Buffer.from([0x0a]),
  cut: Buffer.from([GS, 0x56, 0x42, 0x00]),
  drawer: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]),
};

function widthFor(paperWidth) {
  return Number(paperWidth) >= 80 ? 48 : 32;
}

function money(value, currency = 'ETB') {
  return `${Number(value || 0).toFixed(2)} ${currency}`;
}

function line(char = '-', width = 48) {
  return char.repeat(width);
}

function pad(text, width) {
  return String(text).slice(0, width).padEnd(width, ' ');
}

function twoColumns(left, right, width) {
  const leftText = String(left);
  const rightText = String(right);
  const space = Math.max(1, width - leftText.length - rightText.length);
  return `${leftText}${' '.repeat(space)}${rightText}`.slice(0, width);
}

function clean(value) {
  return String(value == null ? '' : value)
    .replace(/[^\x20-\x7e\n]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function buildTicketText({ type, order, items, settings, station }) {
  const width = widthFor(settings.paperWidth);
  const currency = settings.currency || 'ETB';
  const lines = [];
  lines.push(line('=', width));
  lines.push(center(settings.restaurantName || 'RESTAURANT', width));
  if (station) lines.push(center(`STATION: ${station}`, width));
  lines.push(center(type === 'RECEIPT' ? 'GUEST RECEIPT' : 'KITCHEN TICKET', width));
  lines.push(line('=', width));
  lines.push(twoColumns(`ORDER ${order.orderNumber}`, order.type || 'DINE_IN', width));
  if (order.tableNumber) lines.push(twoColumns(`TABLE ${order.tableNumber}`, `${order.guestCount || 1} guests`, width));
  lines.push(twoColumns(new Date(order.createdAt).toLocaleString('en-GB'), order.deviceId || '', width));
  lines.push(line('-', width));

  for (const item of items) {
    lines.push(twoColumns(`${item.quantity} x ${clean(item.name)}`, money(item.lineTotal, currency), width));
    if (item.notes) lines.push(`   > ${clean(item.notes)}`);
  }

  lines.push(line('-', width));
  if (type === 'RECEIPT') {
    lines.push(twoColumns('Subtotal', money(order.subtotal, currency), width));
    if (Number(order.discountTotal) > 0) lines.push(twoColumns('Discount', money(order.discountTotal, currency), width));
    lines.push(twoColumns(`Tax (${settings.taxRate}%)`, money(order.taxTotal, currency), width));
    if (Number(order.serviceTotal) > 0) lines.push(twoColumns('Service', money(order.serviceTotal, currency), width));
    lines.push(line('=', width));
    lines.push(twoColumns('TOTAL', money(order.total, currency), width));
    lines.push(line('=', width));
    if (settings.receiptFooter) lines.push(center(clean(settings.receiptFooter), width));
  } else {
    lines.push(center('Please prepare promptly', width));
    if (order.notes) lines.push(center(clean(order.notes), width));
  }
  lines.push('');
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

function center(text, width) {
  const value = clean(text);
  if (value.length >= width) return value.slice(0, width);
  const left = Math.floor((width - value.length) / 2);
  return `${' '.repeat(left)}${value}`;
}

function encodeText(text, encoding = 'ascii') {
  try {
    return Buffer.from(text, encoding === 'ascii' ? 'ascii' : 'latin1');
  } catch {
    return Buffer.from(text, 'ascii');
  }
}

function renderTicket(text, options = {}) {
  const chunks = [CMD.init, CMD.alignLeft];
  if (options.boldHeader) chunks.push(CMD.boldOn);
  chunks.push(encodeText(text, options.encoding));
  if (options.boldHeader) chunks.push(CMD.boldOff);
  chunks.push(CMD.feed);
  chunks.push(CMD.feed);
  if (options.cut !== false) chunks.push(CMD.cut);
  if (options.cashDrawer) chunks.push(CMD.drawer);
  return Buffer.concat(chunks);
}

module.exports = {
  CMD,
  buildTicketText,
  renderTicket,
  encodeText,
  money,
  widthFor,
};
