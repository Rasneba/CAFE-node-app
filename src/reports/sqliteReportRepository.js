const { addDays, todayInTimeZone } = require('./dateUtils');

const DETAIL_LIMIT = 500;

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function createSqliteReportRepository(options) {
  return {
    async getRestaurantSales(criteria) {
      const db = require('../db').getDb();
      const from = criteria.from;
      const to = criteria.to;
      const tz = options.timeZone;

      // Build params for date filtering using UTC date boundaries
      const fromStart = `${from}T00:00:00.000Z`;
      const toEnd = `${to}T23:59:59.999Z`;

      const summaryRow = await db.get(
        `SELECT
           COALESCE(SUM(p.amount), 0) AS gross_sales,
           COUNT(p.id) AS payment_count,
           COALESCE(SUM(r.amount), 0) AS refunds,
           COUNT(r.id) AS refund_count,
           COALESCE(SUM(e.amount), 0) AS expenses,
           COUNT(e.id) AS expense_count
         FROM payments p
         LEFT JOIN refunds r ON 1 = 0
         LEFT JOIN expenses e ON 1 = 0
         WHERE p.created_at >= ? AND p.created_at <= ? AND p.voided_at IS NULL`,
        [fromStart, toEnd]
      );

      // Order totals for PAID orders closed in the period
      const orderRow = await db.get(
        `SELECT
           COUNT(*) AS orders,
           COALESCE(SUM(total), 0) AS order_sales,
           COALESCE(AVG(total), 0) AS average_order_value,
           COALESCE(SUM(subtotal), 0) AS subtotal,
           COALESCE(SUM(tax_total), 0) AS tax,
           COALESCE(SUM(service_total), 0) AS service_charge,
           COALESCE(SUM(discount_total), 0) AS discounts
         FROM orders
         WHERE status = 'PAID' AND deleted = 0 AND closed_at >= ? AND closed_at <= ?`,
        [fromStart, toEnd]
      );

      const grossSales = round(summaryRow.gross_sales || 0);
      const refunds = round(summaryRow.refunds || 0);
      const netSales = round(grossSales - refunds);
      const expenses = round(summaryRow.expenses || 0);

      // Daily activity
      const dailyRows = await db.all(
        `SELECT
           date(created_at) AS day,
           COUNT(*) AS orders,
           COALESCE(SUM(amount), 0) AS gross_sales,
           0 AS refunds
         FROM payments
         WHERE created_at >= ? AND created_at <= ? AND voided_at IS NULL
         GROUP BY date(created_at)
         UNION ALL
         SELECT
           date(created_at) AS day,
           0 AS orders,
           0 AS gross_sales,
           COALESCE(SUM(amount), 0) AS refunds
         FROM refunds
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY date(created_at)
         ORDER BY day`,
        [fromStart, toEnd, fromStart, toEnd]
      );

      const dailyMap = new Map();
      for (const row of dailyRows) {
        if (!dailyMap.has(row.day)) {
          dailyMap.set(row.day, { date: row.day, orders: 0, grossSales: 0, refunds: 0 });
        }
        const entry = dailyMap.get(row.day);
        entry.orders += Number(row.orders);
        entry.grossSales = round(entry.grossSales + Number(row.gross_sales));
        entry.refunds = round(entry.refunds + Number(row.refunds));
        entry.netSales = round(entry.grossSales - entry.refunds);
      }
      const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

      // Payment methods
      const methodRows = await db.all(
        `SELECT p.method_code AS code, COALESCE(pm.name, p.method_code) AS name,
                COUNT(*)::int AS transactions, SUM(p.amount)::float AS total
         FROM payments p
         LEFT JOIN payment_methods pm ON pm.code = p.method_code
         WHERE p.created_at >= ? AND p.created_at <= ? AND p.voided_at IS NULL
         GROUP BY p.method_code, pm.name
         ORDER BY total DESC, code`,
        [fromStart, toEnd]
      );

      const paymentMethods = methodRows.map((row) => ({
        code: row.code,
        name: row.name,
        transactions: Number(row.transactions),
        total: round(row.total),
        share: grossSales > 0 ? round((row.total / grossSales) * 100) : 0,
      }));

      // Expense categories
      const expenseRows = await db.all(
        `SELECT category, SUM(amount) AS total, COUNT(*) AS entries
         FROM expenses
         WHERE paid_at >= ? AND paid_at <= ?
         GROUP BY category
         ORDER BY total DESC`,
        [fromStart, toEnd]
      );

      const expenseCategories = expenseRows.map((row) => ({
        category: row.category,
        total: round(row.total),
        entries: Number(row.entries),
      }));

      // Top items
      const itemRows = await db.all(
        `SELECT oi.name, COALESCE(mc.name, 'Uncategorized') AS category,
                SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         LEFT JOIN menu_categories mc ON mc.id = mi.category_id
         WHERE oi.status <> 'CANCELLED' AND o.status = 'PAID' AND o.deleted = 0
           AND o.closed_at >= ? AND o.closed_at <= ?
         GROUP BY oi.name, mc.name
         ORDER BY quantity DESC, revenue DESC
         LIMIT 10`,
        [fromStart, toEnd]
      );

      const topItems = itemRows.map((row) => ({
        name: row.name,
        category: row.category,
        quantity: Number(row.quantity),
        revenue: round(row.revenue),
      }));

      // Order channels
      const channelRows = await db.all(
        `SELECT o.source, COUNT(*) AS orders, SUM(o.total) AS value
         FROM orders o
         WHERE o.status = 'PAID' AND o.deleted = 0
           AND o.closed_at >= ? AND o.closed_at <= ?
         GROUP BY o.source
         ORDER BY value DESC`,
        [fromStart, toEnd]
      );

      const orderChannels = channelRows.map((row) => ({
        source: row.source,
        orders: Number(row.orders),
        value: round(row.value),
      }));

      // Recent orders
      const orderRows = await db.all(
        `SELECT o.id, o.order_number,
                o.closed_at, o.source, o.type, o.subtotal, o.discount_total,
                o.tax_total, o.service_total, o.total, o.paid_total,
                (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'CANCELLED') AS item_count,
                COALESCE((SELECT string_agg(p.method_code, ', ') FROM payments p WHERE p.order_id = o.id AND p.voided_at IS NULL), '') AS payment_methods
         FROM orders o
         WHERE o.status = 'PAID' AND o.deleted = 0
           AND o.closed_at >= ? AND o.closed_at <= ?
         ORDER BY o.closed_at DESC, o.id DESC
         LIMIT ?`,
        [fromStart, toEnd, DETAIL_LIMIT]
      );

      const totalOrdersRow = await db.get(
        `SELECT COUNT(*) AS count FROM orders WHERE status = 'PAID' AND deleted = 0 AND closed_at >= ? AND closed_at <= ?`,
        [fromStart, toEnd]
      );

      const orders = orderRows.map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        closedAt: row.closed_at,
        source: row.source,
        type: row.type,
        itemCount: Number(row.item_count),
        subtotal: round(row.subtotal),
        discounts: round(row.discount_total),
        tax: round(row.tax_total),
        serviceCharge: round(row.service_total),
        total: round(row.total),
        paidTotal: round(row.paid_total),
        paymentMethods: row.payment_methods ? row.payment_methods.split(', ') : [],
      }));

      const grossSalesNum = summaryRow.gross_sales || 0;

      return {
        meta: {
          reportType: 'restaurant-sales',
          title: 'Restaurant Sales Report',
          generatedAt: new Date().toISOString(),
          currency: options.currency,
          timeZone: options.timeZone,
          dataMode: 'sqlite',
          sourceLabel: 'Local SQLite database',
        },
        criteria: { from: criteria.from, to: criteria.to, days: criteria.days },
        summary: {
          grossSales,
          paymentCount: Number(summaryRow.payment_count || 0),
          refunds,
          refundCount: Number(summaryRow.refund_count || 0),
          netSales,
          expenses,
          expenseCount: Number(summaryRow.expense_count || 0),
          operatingResult: round(netSales - expenses),
          orders: Number(orderRow.orders || 0),
          orderSales: round(orderRow.order_sales || 0),
          averageOrderValue: round(orderRow.average_order_value || 0),
          subtotal: round(orderRow.subtotal || 0),
          tax: round(orderRow.tax || 0),
          serviceCharge: round(orderRow.service_charge || 0),
          discounts: round(orderRow.discounts || 0),
        },
        daily,
        paymentMethods,
        expenseCategories,
        topItems,
        orderChannels,
        orders,
        detailLimit: DETAIL_LIMIT,
        totalOrderCount: Number(totalOrdersRow.count || 0),
      };
    },
  };
}

module.exports = { createSqliteReportRepository };
