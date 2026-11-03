const { addDays, todayInTimeZone } = require('./dateUtils');

const DETAIL_LIMIT = 500;
const MENU = [
  { name: 'Doro wat & injera', category: 'Traditional', price: 420 },
  { name: 'Special beef tibs', category: 'Main dishes', price: 480 },
  { name: 'Fasting beyaynetu', category: 'Traditional', price: 260 },
  { name: 'Wild mushroom tagliatelle', category: 'Pasta', price: 385 },
  { name: 'House smash burger', category: 'Burgers', price: 390 },
  { name: 'Citrus grilled salmon', category: 'Main dishes', price: 620 },
  { name: 'Flat white', category: 'Drinks', price: 115 },
  { name: 'Mango & ginger juice', category: 'Drinks', price: 145 },
  { name: 'Cardamom tiramisu', category: 'Desserts', price: 220 },
];
const METHODS = [
  { code: 'CASH', name: 'Cash' },
  { code: 'CARD', name: 'Bank card' },
  { code: 'TELEBIRR', name: 'telebirr' },
];

function createDemoReportRepository(options) {
  let cachedDay;
  let dataset;

  return {
    async getRestaurantSales(criteria) {
      const today = todayInTimeZone(options.timeZone);
      if (!dataset || cachedDay !== today) {
        dataset = buildDataset(today);
        cachedDay = today;
      }
      return assembleReport(dataset, criteria, options);
    },
  };
}

function buildDataset(today) {
  const orders = [];
  const payments = [];
  const refunds = [];
  const expenses = [];
  let id = 0;

  for (let offset = 59; offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    const dayIndex = 59 - offset;
    const orderCount = dayIndex % 7 === 0 ? 2 : 3;

    for (let sequence = 1; sequence <= orderCount; sequence += 1) {
      id += 1;
      const seed = dayIndex * 3 + sequence;
      const first = MENU[seed % MENU.length];
      const second = MENU[(seed * 2 + 3) % MENU.length];
      const firstQuantity = (seed % 2) + 1;
      const secondQuantity = (seed % 3) === 0 ? 2 : 1;
      const items = [
        { ...first, quantity: firstQuantity, revenue: first.price * firstQuantity },
        { ...second, quantity: secondQuantity, revenue: second.price * secondQuantity },
      ];
      const subtotal = items.reduce((sum, item) => sum + item.revenue, 0);
      const discounts = seed % 9 === 0 ? round(subtotal * 0.05) : 0;
      const tax = round((subtotal - discounts) * 0.15);
      const serviceCharge = round((subtotal - discounts) * 0.10);
      const total = round(subtotal - discounts + tax + serviceCharge);
      const hour = 11 + ((seed * 2) % 10);
      const minute = (seed * 7) % 60;
      const closedAt = `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
      const method = METHODS[seed % METHODS.length];
      const orderNumber = `DEMO-${day.replaceAll('-', '').slice(2)}-${String(sequence).padStart(3, '0')}`;

      orders.push({
        id,
        day,
        orderNumber,
        closedAt,
        source: ['STAFF', 'QR', 'ONLINE'][seed % 3],
        type: ['DINE_IN', 'DINE_IN', 'TAKEAWAY', 'DELIVERY'][seed % 4],
        itemCount: firstQuantity + secondQuantity,
        subtotal,
        discounts,
        tax,
        serviceCharge,
        total,
        paidTotal: total,
        paymentMethods: [method.code],
        items,
      });
      payments.push({ day, amount: total, method });

      if (seed % 17 === 0) {
        refunds.push({ day, amount: round(total * 0.08), method });
      }
    }

    if (offset % 3 === 0) {
      const categories = ['Food supplies', 'Utilities', 'Maintenance'];
      expenses.push({
        day,
        category: categories[dayIndex % categories.length],
        amount: 650 + ((dayIndex * 275) % 2400),
      });
    }
  }

  return { orders, payments, refunds, expenses };
}

function assembleReport(dataset, criteria, options) {
  const inPeriod = (row) => row.day >= criteria.from && row.day <= criteria.to;
  const orders = dataset.orders.filter(inPeriod);
  const payments = dataset.payments.filter(inPeriod);
  const refunds = dataset.refunds.filter(inPeriod);
  const expenses = dataset.expenses.filter(inPeriod);
  const sum = (rows, key = 'amount') => round(rows.reduce((total, row) => total + Number(row[key]), 0));

  const grossSales = sum(payments);
  const refunded = sum(refunds);
  const expenseTotal = sum(expenses);
  const netSales = round(grossSales - refunded);
  const orderSales = sum(orders, 'total');
  const dailyMap = new Map();
  const methodMap = new Map();
  const itemMap = new Map();
  const channelMap = new Map();
  const expenseMap = new Map();

  const dayEntry = (day) => {
    if (!dailyMap.has(day)) {
      dailyMap.set(day, { date: day, orders: 0, grossSales: 0, refunds: 0, netSales: 0 });
    }
    return dailyMap.get(day);
  };

  for (const payment of payments) {
    dayEntry(payment.day).grossSales = round(dayEntry(payment.day).grossSales + payment.amount);
    if (!methodMap.has(payment.method.code)) {
      methodMap.set(payment.method.code, { ...payment.method, transactions: 0, total: 0, share: 0 });
    }
    const method = methodMap.get(payment.method.code);
    method.transactions += 1;
    method.total = round(method.total + payment.amount);
  }
  for (const refund of refunds) {
    dayEntry(refund.day).refunds = round(dayEntry(refund.day).refunds + refund.amount);
  }
  for (const order of orders) {
    dayEntry(order.day).orders += 1;
    if (!channelMap.has(order.source)) {
      channelMap.set(order.source, { source: order.source, orders: 0, value: 0 });
    }
    const channel = channelMap.get(order.source);
    channel.orders += 1;
    channel.value = round(channel.value + order.total);

    for (const item of order.items) {
      if (!itemMap.has(item.name)) {
        itemMap.set(item.name, { name: item.name, category: item.category, quantity: 0, revenue: 0 });
      }
      const reportItem = itemMap.get(item.name);
      reportItem.quantity += item.quantity;
      reportItem.revenue = round(reportItem.revenue + item.revenue);
    }
  }
  for (const row of dailyMap.values()) {
    row.netSales = round(row.grossSales - row.refunds);
  }
  for (const method of methodMap.values()) {
    method.share = grossSales > 0 ? round((method.total / grossSales) * 100) : 0;
  }
  for (const expense of expenses) {
    if (!expenseMap.has(expense.category)) {
      expenseMap.set(expense.category, { category: expense.category, entries: 0, total: 0 });
    }
    const category = expenseMap.get(expense.category);
    category.entries += 1;
    category.total = round(category.total + expense.amount);
  }

  const orderedOrders = [...orders].sort((a, b) => b.closedAt.localeCompare(a.closedAt));

  return {
    meta: {
      reportType: 'restaurant-sales',
      title: 'Restaurant Sales Report',
      generatedAt: new Date().toISOString(),
      currency: options.currency,
      timeZone: options.timeZone,
      dataMode: 'demo',
      sourceLabel: 'Demo data · connect Neon for live data',
    },
    criteria: { from: criteria.from, to: criteria.to, days: criteria.days },
    summary: {
      grossSales,
      paymentCount: payments.length,
      refunds: refunded,
      refundCount: refunds.length,
      netSales,
      expenses: expenseTotal,
      expenseCount: expenses.length,
      operatingResult: round(netSales - expenseTotal),
      orders: orders.length,
      orderSales,
      averageOrderValue: orders.length ? round(orderSales / orders.length) : 0,
      subtotal: sum(orders, 'subtotal'),
      tax: sum(orders, 'tax'),
      serviceCharge: sum(orders, 'serviceCharge'),
      discounts: sum(orders, 'discounts'),
    },
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    paymentMethods: [...methodMap.values()].sort((a, b) => b.total - a.total),
    expenseCategories: [...expenseMap.values()].sort((a, b) => b.total - a.total),
    topItems: [...itemMap.values()]
      .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
      .slice(0, 10),
    orderChannels: [...channelMap.values()].sort((a, b) => b.value - a.value),
    orders: orderedOrders.slice(0, DETAIL_LIMIT).map(({ day, items, ...order }) => order),
    detailLimit: DETAIL_LIMIT,
  };
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

module.exports = { createDemoReportRepository };
