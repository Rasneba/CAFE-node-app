const { getDb } = require('../db');

const DETAIL_LIMIT = 500;

async function query(sql, params) {
  const db = getDb();
  return { rows: await db.all(sql, params) };
}

const paymentPeriod = `p.created_at::timestamptz >= ($1::date::timestamp AT TIME ZONE $3)
    AND p.created_at::timestamptz < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)`;
const orderPeriod = `o.closed_at::timestamptz >= ($1::date::timestamp AT TIME ZONE $3)
    AND o.closed_at::timestamptz < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)`;

async function getRestaurantSales(criteria, options) {
  const params = [criteria.from, criteria.to, options.timeZone];

  const summarySql = `
    WITH payment_totals AS (
      SELECT COALESCE(SUM(p.amount), 0) AS amount, COUNT(*) AS entries
      FROM payments p
      WHERE ${paymentPeriod} AND p.voided_at IS NULL
    ), refund_totals AS (
      SELECT COALESCE(SUM(r.amount), 0) AS amount, COUNT(*) AS entries
      FROM refunds r
      WHERE r.created_at::timestamptz >= ($1::date::timestamp AT TIME ZONE $3)
        AND r.created_at::timestamptz < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)
    ), expense_totals AS (
      SELECT COALESCE(SUM(e.amount), 0) AS amount, COUNT(*) AS entries
      FROM expenses e
      WHERE e.paid_at::timestamptz >= ($1::date::timestamp AT TIME ZONE $3)
        AND e.paid_at::timestamptz < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)
    ), order_totals AS (
      SELECT COUNT(*) AS entries,
             COALESCE(SUM(o.total), 0) AS sales,
             COALESCE(AVG(o.total), 0) AS average,
             COALESCE(SUM(o.subtotal), 0) AS subtotal,
             COALESCE(SUM(o.tax_total), 0) AS tax,
             COALESCE(SUM(o.service_total), 0) AS service,
             COALESCE(SUM(o.discount_total), 0) AS discounts
      FROM orders o
      WHERE o.status = 'PAID' AND ${orderPeriod}
    )
    SELECT p.amount::float AS gross_sales, p.entries::int AS payment_count,
           r.amount::float AS refunds, r.entries::int AS refund_count,
           e.amount::float AS expenses, e.entries::int AS expense_count,
           o.entries::int AS orders, o.sales::float AS order_sales,
           o.average::float AS average_order_value, o.subtotal::float AS subtotal,
           o.tax::float AS tax, o.service::float AS service_charge,
           o.discounts::float AS discounts
    FROM payment_totals p, refund_totals r, expense_totals e, order_totals o`;

  const dailySql = `
    WITH activity AS (
      SELECT (p.created_at::timestamptz AT TIME ZONE $3)::date AS day,
             p.amount AS gross, 0::numeric AS refunded, 0 AS orders
      FROM payments p
      WHERE ${paymentPeriod} AND p.voided_at IS NULL
      UNION ALL
      SELECT (r.created_at::timestamptz AT TIME ZONE $3)::date AS day,
             0::numeric AS gross, r.amount AS refunded, 0 AS orders
      FROM refunds r
      WHERE r.created_at::timestamptz >= ($1::date::timestamp AT TIME ZONE $3)
        AND r.created_at::timestamptz < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)
      UNION ALL
      SELECT (o.closed_at::timestamptz AT TIME ZONE $3)::date AS day,
             0::numeric AS gross, 0::numeric AS refunded, 1 AS orders
      FROM orders o
      WHERE o.status = 'PAID' AND ${orderPeriod}
    )
    SELECT to_char(day, 'YYYY-MM-DD') AS date,
           SUM(orders)::int AS orders, SUM(gross)::float AS gross_sales,
           SUM(refunded)::float AS refunds
    FROM activity
    GROUP BY day
    ORDER BY day`;

  const methodsSql = `
    SELECT p.method_code AS code, COALESCE(pm.name, p.method_code) AS name,
           COUNT(*)::int AS transactions, SUM(p.amount)::float AS total
    FROM payments p
    LEFT JOIN payment_methods pm ON pm.code = p.method_code
    WHERE ${paymentPeriod} AND p.voided_at IS NULL
    GROUP BY p.method_code, pm.name
    ORDER BY total DESC, code`;

  const expensesSql = `
    SELECT e.category, SUM(e.amount)::float AS total, COUNT(*)::int AS entries
    FROM expenses e
    WHERE e.paid_at::timestamptz >= ($1::date::timestamp AT TIME ZONE $3)
      AND e.paid_at::timestamptz < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)
    GROUP BY e.category
    ORDER BY total DESC, e.category`;

  const itemsSql = `
    SELECT oi.name, COALESCE(mc.name, 'Uncategorized') AS category,
           SUM(oi.quantity)::int AS quantity, SUM(oi.line_total)::float AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN menu_categories mc ON mc.id = mi.category_id
    WHERE oi.status <> 'CANCELLED' AND o.status = 'PAID' AND ${orderPeriod}
    GROUP BY oi.name, mc.name
    ORDER BY quantity DESC, revenue DESC, oi.name
    LIMIT 10`;

  const channelsSql = `
    SELECT o.source, COUNT(*)::int AS orders, SUM(o.total)::float AS value
    FROM orders o
    WHERE o.status = 'PAID' AND ${orderPeriod}
    GROUP BY o.source
    ORDER BY value DESC, o.source`;

  const ordersSql = `
    SELECT o.id::int, o.order_number,
           to_char(o.closed_at::timestamptz AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS') AS closed_at,
           o.source, o.type, o.subtotal::float, o.discount_total::float,
           o.tax_total::float, o.service_total::float, o.total::float,
           o.paid_total::float,
           (SELECT COUNT(*) FROM order_items oi
            WHERE oi.order_id = o.id AND oi.status <> 'CANCELLED')::int AS item_count,
           COALESCE((SELECT string_agg(p.method_code, ', ' ORDER BY p.method_code)
                     FROM payments p
                     WHERE p.order_id = o.id AND p.voided_at IS NULL), '') AS payment_methods
    FROM orders o
    WHERE o.status = 'PAID' AND ${orderPeriod}
    ORDER BY o.closed_at::timestamptz DESC, o.id DESC
    LIMIT ${DETAIL_LIMIT}`;

  const [summary, daily, methods, expenses, items, channels, orders] = await Promise.all([
    query(summarySql, params),
    query(dailySql, params),
    query(methodsSql, params),
    query(expensesSql, params),
    query(itemsSql, params),
    query(channelsSql, params),
    query(ordersSql, params),
  ]);

  const totals = summary.rows[0];
  const grossSales = totals.gross_sales;
  const refunds = totals.refunds;
  const netSales = round(grossSales - refunds);

  return {
    meta: {
      reportType: 'restaurant-sales',
      title: 'Restaurant Sales Report',
      generatedAt: new Date().toISOString(),
      currency: options.currency,
      timeZone: options.timeZone,
      dataMode: 'postgresql',
      sourceLabel: 'PostgreSQL database',
    },
    criteria: { from: criteria.from, to: criteria.to, days: criteria.days },
    summary: {
      grossSales,
      paymentCount: totals.payment_count,
      refunds,
      refundCount: totals.refund_count,
      netSales,
      expenses: totals.expenses,
      expenseCount: totals.expense_count,
      operatingResult: round(netSales - totals.expenses),
      orders: totals.orders,
      orderSales: totals.order_sales,
      averageOrderValue: totals.average_order_value,
      subtotal: totals.subtotal,
      tax: totals.tax,
      serviceCharge: totals.service_charge,
      discounts: totals.discounts,
    },
    daily: daily.rows.map((row) => ({
      date: row.date,
      orders: row.orders,
      grossSales: row.gross_sales,
      refunds: row.refunds,
      netSales: round(row.gross_sales - row.refunds),
    })),
    paymentMethods: methods.rows.map((row) => ({
      code: row.code,
      name: row.name,
      transactions: row.transactions,
      total: row.total,
      share: grossSales > 0 ? round((row.total / grossSales) * 100) : 0,
    })),
    expenseCategories: expenses.rows,
    topItems: items.rows,
    orderChannels: channels.rows,
    orders: orders.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      closedAt: row.closed_at,
      source: row.source,
      type: row.type,
      itemCount: row.item_count,
      subtotal: row.subtotal,
      discounts: row.discount_total,
      tax: row.tax_total,
      serviceCharge: row.service_total,
      total: row.total,
      paidTotal: row.paid_total,
      paymentMethods: row.payment_methods ? row.payment_methods.split(', ') : [],
    })),
    detailLimit: DETAIL_LIMIT,
  };
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

module.exports = { DETAIL_LIMIT, getRestaurantSales };

