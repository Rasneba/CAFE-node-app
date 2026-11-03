const crypto = require('node:crypto');
const config = require('./config');
const { audit } = require('./auth');

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

async function lowStockIngredients(db) {
  const rows = await db.all(
    `SELECT i.*, s.name AS supplier_name
     FROM ingredients i
     LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.deleted = 0 AND i.active = 1 AND i.current_stock <= i.min_stock
     ORDER BY (i.current_stock - i.min_stock) ASC, i.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    uuid: row.sync_id,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    currentStock: Number(row.current_stock),
    minStock: Number(row.min_stock),
    costPerUnit: Number(row.cost_per_unit),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    stockValue: money(Number(row.current_stock) * Number(row.cost_per_unit)),
    lowStock: true,
  }));
}

async function allIngredients(db) {
  const rows = await db.all(
    `SELECT i.*, s.name AS supplier_name
     FROM ingredients i
     LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.deleted = 0
     ORDER BY i.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    uuid: row.sync_id,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    currentStock: Number(row.current_stock),
    minStock: Number(row.min_stock),
    costPerUnit: Number(row.cost_per_unit),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    stockValue: money(Number(row.current_stock) * Number(row.cost_per_unit)),
    lowStock: Number(row.current_stock) <= Number(row.min_stock),
    active: Boolean(row.active),
  }));
}

async function stockMovements(db, options = {}) {
  const limit = Math.min(Number(options.limit || 50), 200);
  const params = [];
  let where = 'WHERE 1 = 1';
  if (options.ingredientId) {
    where += ' AND sm.ingredient_id = ?';
    params.push(Number(options.ingredientId));
  }
  if (options.movementType) {
    where += ' AND sm.movement_type = ?';
    params.push(options.movementType);
  }
  if (options.from) {
    where += ' AND sm.created_at >= ?';
    params.push(options.from);
  }
  if (options.to) {
    where += ' AND sm.created_at <= ?';
    params.push(options.to);
  }
  const rows = await db.all(
    `SELECT sm.*, i.name AS ingredient_name, u.name AS created_by_name
     FROM stock_movements sm
     LEFT JOIN ingredients i ON i.id = sm.ingredient_id
     LEFT JOIN users u ON u.id = sm.created_by
     ${where}
     ORDER BY sm.id DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    uuid: row.sync_id,
    ingredientId: row.ingredient_id,
    ingredientName: row.ingredient_name,
    movementType: row.movement_type,
    quantity: Number(row.quantity),
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    notes: row.notes,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
  }));
}

async function getRecipeLines(db, recipeId) {
  const rows = await db.all(
    `SELECT ri.*, i.name AS ingredient_name, i.unit AS ingredient_unit, i.current_stock, i.min_stock, i.cost_per_unit
     FROM recipe_ingredients ri
     LEFT JOIN ingredients i ON i.id = ri.ingredient_id
     WHERE ri.recipe_id = ?
     ORDER BY ri.id`,
    [recipeId],
  );
  return rows.map((row) => ({
    id: row.id,
    recipeId: row.recipe_id,
    ingredientId: row.ingredient_id,
    ingredientName: row.ingredient_name,
    ingredientUnit: row.ingredient_unit,
    quantity: Number(row.quantity),
    unit: row.unit || row.ingredient_unit,
    currentStock: row.current_stock == null ? null : Number(row.current_stock),
    minStock: row.min_stock == null ? null : Number(row.min_stock),
    costPerUnit: row.cost_per_unit == null ? null : Number(row.cost_per_unit),
  }));
}

async function deductOrderInventory(db, orderOrSyncId, userId) {
  const order = typeof orderOrSyncId === 'string'
    ? await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [orderOrSyncId])
    : orderOrSyncId;
  if (!order || order.inventory_deducted_at) return { movements: [], skipped: true };
  const deductEnabled = await db.get(
    "SELECT value FROM sync_state WHERE key = 'deduct_stock_on_submit'",
  );
  const settings = await db.get('SELECT * FROM settings WHERE id = 1');
  const enabled = settings && Number(settings.deduct_stock_on_submit) !== 0 ? 1 : deductEnabled ? Number(deductEnabled.value) : 1;
  if (!enabled) return { movements: [], skipped: true };

  const items = await db.all('SELECT * FROM order_items WHERE order_id = ? AND deleted = 0', [order.id]);
  const movements = [];
  const now = new Date().toISOString();

  await db.tx(async (tx) => {
    for (const item of items) {
      const recipe = await tx.get('SELECT * FROM recipes WHERE menu_item_id = ? AND deleted = 0', [item.menu_item_id]);
      if (!recipe) continue;
      const lines = await getRecipeLines(tx, recipe.id);
      for (const line of lines) {
        const quantity = money(Number(line.quantity) * Number(item.quantity));
        if (quantity <= 0) continue;
        await tx.run(
          'UPDATE ingredients SET current_stock = current_stock - ?, updated_at = ? WHERE id = ? AND deleted = 0',
          [quantity, now, line.ingredientId],
        );
        await tx.run(
          `INSERT INTO stock_movements
             (sync_id, ingredient_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, created_at)
           VALUES (?, ?, 'SALE_DEDUCTION', ?, ?, 'ORDER', ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            line.ingredientId,
            quantity,
            line.costPerUnit || null,
            order.sync_id,
            `${order.order_number} - ${item.name}`,
            userId || null,
            now,
          ],
        );
        movements.push({
          ingredientId: line.ingredientId,
          ingredientName: line.ingredientName,
          movementType: 'SALE_DEDUCTION',
          quantity,
          unitCost: line.costPerUnit,
          referenceType: 'ORDER',
          referenceId: order.sync_id,
          notes: `${order.order_number} - ${item.name}`,
          createdAt: now,
        });
      }
    }

    await tx.run(
      'UPDATE orders SET inventory_deducted_at = ? WHERE id = ? AND (inventory_deducted_at IS NULL OR inventory_deducted_at = \'\')',
      [now, order.id],
    );
  });

  return { movements, skipped: false };
}

async function restoreOrderInventory(db, orderOrSyncId, userId) {
  const order = typeof orderOrSyncId === 'string'
    ? await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [orderOrSyncId])
    : orderOrSyncId;
  if (!order || !order.inventory_deducted_at) return { movements: [], skipped: true };
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ? AND deleted = 0', [order.id]);
  const movements = [];
  const now = new Date().toISOString();

  await db.tx(async (tx) => {
    for (const item of items) {
      const recipe = await tx.get('SELECT * FROM recipes WHERE menu_item_id = ? AND deleted = 0', [item.menu_item_id]);
      if (!recipe) continue;
      const lines = await getRecipeLines(tx, recipe.id);
      for (const line of lines) {
        const quantity = money(Number(line.quantity) * Number(item.quantity));
        if (quantity <= 0) continue;
        await tx.run(
          'UPDATE ingredients SET current_stock = current_stock + ?, updated_at = ? WHERE id = ? AND deleted = 0',
          [quantity, now, line.ingredientId],
        );
        await tx.run(
          `INSERT INTO stock_movements
             (sync_id, ingredient_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, created_at)
           VALUES (?, ?, 'SALE_RESTORATION', ?, ?, 'ORDER', ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            line.ingredientId,
            quantity,
            line.costPerUnit || null,
            order.sync_id,
            `${order.order_number} - ${item.name} (restored)`,
            userId || null,
            now,
          ],
        );
        movements.push({
          ingredientId: line.ingredientId,
          ingredientName: line.ingredientName,
          movementType: 'SALE_RESTORATION',
          quantity,
          unitCost: line.costPerUnit,
          referenceType: 'ORDER',
          referenceId: order.sync_id,
          notes: `${order.order_number} - ${item.name} (restored)`,
          createdAt: now,
        });
      }
    }

    await tx.run(
      'UPDATE orders SET inventory_deducted_at = NULL WHERE id = ?',
      [order.id],
    );
  });

  return { movements, skipped: false };
}

async function adjustIngredientStock(db, { ingredientId, quantity, unitCost, referenceType, referenceId, notes, userId }) {
  const ingredient = await db.get('SELECT * FROM ingredients WHERE id = ? AND deleted = 0', [Number(ingredientId)]);
  if (!ingredient) {
    const error = new Error('Ingredient not found.');
    error.status = 404;
    throw error;
  }
  const qty = Number(quantity || 0);
  const now = new Date().toISOString();
  await db.tx(async (tx) => {
    await tx.run(
      'UPDATE ingredients SET current_stock = current_stock + ?, updated_at = ? WHERE id = ?',
      [qty, now, ingredient.id],
    );
    await tx.run(
      `INSERT INTO stock_movements
         (sync_id, ingredient_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, created_at)
       VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        ingredient.id,
        qty,
        unitCost == null ? null : Number(unitCost),
        referenceType || 'MANUAL',
        referenceId || null,
        notes || null,
        userId || null,
        now,
      ],
    );
  });
  const updated = await db.get('SELECT * FROM ingredients WHERE id = ?', [ingredient.id]);
  return {
    ingredient: {
      id: updated.id,
      uuid: updated.sync_id,
      name: updated.name,
      currentStock: Number(updated.current_stock),
      minStock: Number(updated.min_stock),
      lowStock: Number(updated.current_stock) <= Number(updated.min_stock),
    },
    movement: {
      movementType: 'ADJUSTMENT',
      quantity: qty,
      unitCost: unitCost == null ? null : Number(unitCost),
      referenceType: referenceType || 'MANUAL',
      referenceId: referenceId || null,
      notes: notes || null,
      createdAt: now,
    },
  };
}

module.exports = {
  money,
  lowStockIngredients,
  allIngredients,
  stockMovements,
  getRecipeLines,
  deductOrderInventory,
  restoreOrderInventory,
  adjustIngredientStock,
};
