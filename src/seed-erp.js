const crypto = require('node:crypto');
const { nowIso } = require('./db');
const { hashPassword } = require('./auth');

const PERMISSIONS = [
  ['dashboard.view', 'View dashboard', 'Dashboard'],
  ['floor.view', 'View floor plan', 'Floor'],
  ['floor.manage', 'Manage floor plan', 'Floor'],
  ['pos.use', 'Use point of sale', 'POS'],
  ['orders.view', 'View orders', 'Orders'],
  ['orders.manage', 'Manage orders', 'Orders'],
  ['orders.cancel', 'Cancel orders', 'Orders'],
  ['kitchen.view', 'View kitchen tickets', 'Kitchen'],
  ['kitchen.manage', 'Manage kitchen tickets', 'Kitchen'],
  ['bar.view', 'View bar tickets', 'Bar'],
  ['bar.manage', 'Manage bar tickets', 'Bar'],
  ['billing.view', 'View billing', 'Billing'],
  ['billing.pay', 'Take payments', 'Billing'],
  ['billing.refund', 'Process refunds', 'Billing'],
  ['menu.view', 'View menu', 'Menu'],
  ['menu.manage', 'Manage menu', 'Menu'],
  ['inventory.view', 'View inventory', 'Inventory'],
  ['inventory.manage', 'Manage inventory', 'Inventory'],
  ['purchasing.view', 'View purchasing', 'Purchasing'],
  ['purchasing.manage', 'Manage purchasing', 'Purchasing'],
  ['expenses.view', 'View expenses', 'Expenses'],
  ['expenses.manage', 'Manage expenses', 'Expenses'],
  ['reservations.view', 'View reservations', 'Reservations'],
  ['reservations.manage', 'Manage reservations', 'Reservations'],
  ['customers.view', 'View customers', 'Customers'],
  ['customers.manage', 'Manage customers', 'Customers'],
  ['staff.view', 'View staff', 'Staff'],
  ['staff.manage', 'Manage staff', 'Staff'],
  ['reports.view', 'View reports', 'Reports'],
  ['settings.manage', 'Manage settings', 'Settings'],
  ['audit.view', 'View audit log', 'Audit'],
  ['printers.manage', 'Manage printers', 'Printers'],
];

const ROLES = [
  { code: 'OWNER', name: 'Owner', description: 'Full access to everything.', isSystem: 1 },
  { code: 'MANAGER', name: 'Manager', description: 'Manage operations, staff, inventory, purchasing and settings.', isSystem: 1 },
  { code: 'CASHIER', name: 'Cashier', description: 'Take orders and payments at the POS.', isSystem: 1 },
  { code: 'WAITER', name: 'Waiter', description: 'Take orders and send them to kitchen/bar.', isSystem: 1 },
  { code: 'KITCHEN', name: 'Kitchen', description: 'Manage kitchen tickets and preparation status.', isSystem: 1 },
  { code: 'BAR', name: 'Bar', description: 'Manage bar tickets and drinks preparation.', isSystem: 1 },
  { code: 'INVENTORY', name: 'Inventory', description: 'Manage ingredients, recipes and supplier orders.', isSystem: 1 },
  { code: 'ACCOUNTANT', name: 'Accountant', description: 'View billing, expenses and reports.', isSystem: 1 },
];

const ROLE_PERMISSIONS = {
  OWNER: PERMISSIONS.map(([code]) => code),
  MANAGER: PERMISSIONS.map(([code]) => code),
  CASHIER: [
    'dashboard.view', 'pos.use', 'orders.view', 'orders.manage', 'kitchen.view', 'bar.view',
    'billing.view', 'billing.pay', 'customers.view',
  ],
  WAITER: [
    'dashboard.view', 'pos.use', 'orders.view', 'orders.manage', 'kitchen.view', 'bar.view',
    'billing.view', 'customers.view',
  ],
  KITCHEN: [
    'dashboard.view', 'kitchen.view', 'kitchen.manage', 'orders.view', 'bar.view',
  ],
  BAR: [
    'dashboard.view', 'bar.view', 'bar.manage', 'orders.view', 'kitchen.view',
  ],
  INVENTORY: [
    'dashboard.view', 'inventory.view', 'inventory.manage', 'purchasing.view', 'purchasing.manage',
  ],
  ACCOUNTANT: [
    'dashboard.view', 'billing.view', 'expenses.view', 'expenses.manage', 'reports.view', 'audit.view',
  ],
};

const USERS = [
  { name: 'System Owner', email: 'owner@genius.et', password: 'Admin@12345', role: 'OWNER', superAdmin: 1 },
  { name: 'Restaurant Manager', email: 'manager@genius.et', password: 'Manager@12345', role: 'MANAGER', superAdmin: 0 },
  { name: 'Cashier User', email: 'cashier@genius.et', password: 'Cashier@12345', role: 'CASHIER', superAdmin: 0 },
  { name: 'Waiter User', email: 'waiter@genius.et', password: 'Waiter@12345', role: 'WAITER', superAdmin: 0 },
  { name: 'Kitchen User', email: 'kitchen@genius.et', password: 'Kitchen@12345', role: 'KITCHEN', superAdmin: 0 },
  { name: 'Bar User', email: 'bar@genius.et', password: 'Bar@12345', role: 'BAR', superAdmin: 0 },
  { name: 'Inventory User', email: 'inventory@genius.et', password: 'Inventory@12345', role: 'INVENTORY', superAdmin: 0 },
  { name: 'Accountant User', email: 'accountant@genius.et', password: 'Accountant@12345', role: 'ACCOUNTANT', superAdmin: 0 },
];

const SUPPLIERS = [
  { name: 'Addis Food Distributors', contactName: 'Procurement Desk', phone: '+251 91 111 1111', email: 'orders@addisfood.example', address: 'Addis Ababa, Ethiopia', taxNumber: 'TIN-100001', notes: 'Dry goods, produce and meat supplier.' },
  { name: 'Awash Beverages', contactName: 'Sales Desk', phone: '+251 92 222 2222', email: 'sales@awashbev.example', address: 'Addis Ababa, Ethiopia', taxNumber: 'TIN-100002', notes: 'Coffee, juices and bottled water supplier.' },
];

const INGREDIENTS = [
  { name: 'Teff flour', unit: 'kg', currentStock: 50, minStock: 10, costPerUnit: 120, supplier: 'Addis Food Distributors' },
  { name: 'Berbere spice', unit: 'pcs', currentStock: 20, minStock: 5, costPerUnit: 90, supplier: 'Addis Food Distributors' },
  { name: 'Chicken', unit: 'kg', currentStock: 30, minStock: 5, costPerUnit: 250, supplier: 'Addis Food Distributors' },
  { name: 'Eggs', unit: 'pcs', currentStock: 100, minStock: 20, costPerUnit: 3, supplier: 'Addis Food Distributors' },
  { name: 'Butter', unit: 'kg', currentStock: 10, minStock: 2, costPerUnit: 180, supplier: 'Addis Food Distributors' },
  { name: 'Coffee beans', unit: 'kg', currentStock: 5, minStock: 1, costPerUnit: 400, supplier: 'Awash Beverages' },
  { name: 'Milk', unit: 'liters', currentStock: 20, minStock: 5, costPerUnit: 25, supplier: 'Awash Beverages' },
  { name: 'Sugar', unit: 'kg', currentStock: 5, minStock: 1, costPerUnit: 20, supplier: 'Awash Beverages' },
  { name: 'Bottled water', unit: 'pcs', currentStock: 100, minStock: 20, costPerUnit: 5, supplier: 'Awash Beverages' },
  { name: 'Injera flour', unit: 'kg', currentStock: 40, minStock: 10, costPerUnit: 60, supplier: 'Addis Food Distributors' },
];

async function insertBranch(db) {
  const existing = await db.get("SELECT id FROM branches WHERE code = 'MAIN' AND deleted = 0");
  if (existing) return existing.id;
  const now = nowIso();
  const row = await db.get(
    `INSERT INTO branches (sync_id, name, code, address, phone, active, created_at, updated_at, deleted)
     VALUES (?, 'Main Branch', 'MAIN', 'Addis Ababa, Ethiopia', '+251 11 111 1111', 1, ?, ?, 0)
     RETURNING id`,
    [crypto.randomUUID(), now, now],
  );
  return row.id;
}

async function insertFloor(db, branchId) {
  const existing = await db.get("SELECT id FROM floors WHERE name = 'Main Floor' AND deleted = 0");
  if (existing) return existing.id;
  const now = nowIso();
  const row = await db.get(
    `INSERT INTO floors (sync_id, branch_id, name, sort, active, updated_at, deleted)
     VALUES (?, ?, 'Main Floor', 1, 1, ?, 0) RETURNING id`,
    [crypto.randomUUID(), branchId, now],
  );
  return row.id;
}

async function insertSection(db, floorId, name, sort) {
  const existing = await db.get(`SELECT id FROM sections WHERE name = ? AND deleted = 0`, [name]);
  if (existing) return existing.id;
  const now = nowIso();
  const row = await db.get(
    `INSERT INTO sections (sync_id, floor_id, name, sort, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, 0) RETURNING id`,
    [crypto.randomUUID(), floorId, name, sort, now],
  );
  return row.id;
}

async function upsertPermissions(db) {
  for (const [code, name, module] of PERMISSIONS) {
    await db.run(
      `INSERT INTO permissions (code, name, module) VALUES (?, ?, ?)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, module = excluded.module`,
      [code, name, module],
    );
  }
}

async function upsertRoles(db) {
  const roleIds = {};
  for (const role of ROLES) {
    const row = await db.get(
      `INSERT INTO roles (code, name, description, is_system, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, description = excluded.description
       RETURNING id`,
      [role.code, role.name, role.description, role.isSystem, nowIso()],
    );
    roleIds[role.code] = row.id;
  }
  for (const [code, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    await db.run('DELETE FROM role_permissions WHERE role_id = ?', [roleIds[code]]);
    for (const permission of permissions) {
      await db.run('INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)', [roleIds[code], permission]);
    }
  }
  return roleIds;
}

async function upsertUsers(db, roleIds) {
  const branchId = await insertBranch(db);
  const floorId = await insertFloor(db, branchId);
  await insertSection(db, floorId, 'Dining', 1);
  await insertSection(db, floorId, 'Bar', 2);
  await insertSection(db, floorId, 'Terrace', 3);

  for (const user of USERS) {
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO users (sync_id, name, email, phone, password_hash, active, is_super_admin, branch_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0)
       ON CONFLICT (email) DO UPDATE SET
         name = excluded.name,
         password_hash = excluded.password_hash,
         active = 1,
         branch_id = excluded.branch_id,
         updated_at = excluded.updated_at,
         deleted = 0
       RETURNING id`,
      [
        crypto.randomUUID(),
        user.name,
        user.email,
        '+251 90 000 0000',
        hashPassword(user.password),
        user.superAdmin,
        branchId,
        now,
        now,
      ],
    );
    await db.run('DELETE FROM user_roles WHERE user_id = ?', [row.id]);
    await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [row.id, roleIds[user.role]]);
  }
  return branchId;
}

async function upsertSuppliersAndIngredients(db) {
  const supplierIds = {};
  for (const supplier of SUPPLIERS) {
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO suppliers (sync_id, name, contact_name, phone, email, address, tax_number, notes, active, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
       ON CONFLICT (name) DO UPDATE SET
         contact_name = excluded.contact_name,
         phone = excluded.phone,
         email = excluded.email,
         address = excluded.address,
         tax_number = excluded.tax_number,
         notes = excluded.notes,
         updated_at = excluded.updated_at
       RETURNING id`,
      [
        crypto.randomUUID(),
        supplier.name,
        supplier.contactName,
        supplier.phone,
        supplier.email,
        supplier.address,
        supplier.taxNumber,
        supplier.notes,
        now,
        now,
      ],
    );
    supplierIds[supplier.name] = row.id;
  }

  for (const ingredient of INGREDIENTS) {
    const now = nowIso();
    await db.run(
      `INSERT INTO ingredients (sync_id, name, sku, unit, current_stock, min_stock, cost_per_unit, supplier_id, active, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
       ON CONFLICT (name) DO UPDATE SET
         unit = excluded.unit,
         current_stock = excluded.current_stock,
         min_stock = excluded.min_stock,
         cost_per_unit = excluded.cost_per_unit,
         supplier_id = excluded.supplier_id,
         updated_at = excluded.updated_at`,
      [
        crypto.randomUUID(),
        ingredient.name,
        ingredient.name.toUpperCase().replace(/\s+/g, '-'),
        ingredient.unit,
        ingredient.currentStock,
        ingredient.minStock,
        ingredient.costPerUnit,
        supplierIds[ingredient.supplier],
        now,
        now,
      ],
    );
  }
}

async function upsertRecipes(db) {
  const recipeMap = {
    'Doro wat & injera': [
      { ingredient: 'Chicken', quantity: 0.4, unit: 'kg' },
      { ingredient: 'Berbere spice', quantity: 30, unit: 'g' },
      { ingredient: 'Butter', quantity: 40, unit: 'g' },
      { ingredient: 'Eggs', quantity: 1, unit: 'pcs' },
      { ingredient: 'Injera flour', quantity: 0.25, unit: 'kg' },
    ],
    'Wild mushroom tagliatelle': [
      { ingredient: 'Butter', quantity: 30, unit: 'g' },
      { ingredient: 'Milk', quantity: 0.1, unit: 'liters' },
    ],
    'Flat white': [
      { ingredient: 'Coffee beans', quantity: 0.02, unit: 'kg' },
      { ingredient: 'Milk', quantity: 0.15, unit: 'liters' },
    ],
  };

  for (const [menuItemName, lines] of Object.entries(recipeMap)) {
    const menuItem = await db.get('SELECT id FROM menu_items WHERE name = ? AND deleted = 0', [menuItemName]);
    if (!menuItem) continue;
    const now = nowIso();
    await db.run(
      `INSERT INTO recipes (sync_id, menu_item_id, name, yield_qty, notes, created_at, updated_at, deleted)
       VALUES (?, ?, ?, 1, ?, ?, ?, 0)
       ON CONFLICT (menu_item_id) DO NOTHING`,
      [crypto.randomUUID(), menuItem.id, `Recipe for ${menuItemName}`, 'Standard portion', now, now],
    );
    const recipe = await db.get('SELECT id FROM recipes WHERE menu_item_id = ?', [menuItem.id]);
    if (!recipe) continue;
    await db.run('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [recipe.id]);
    for (const line of lines) {
      const ingredient = await db.get('SELECT id FROM ingredients WHERE name = ? AND deleted = 0', [line.ingredient]);
      if (!ingredient) continue;
      await db.run(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [recipe.id, ingredient.id, Number(line.quantity), line.unit, now],
      );
    }
  }
}

async function seedErpData(db, options = {}) {
  const force = Boolean(options.force);
  const marker = await db.get("SELECT value FROM sync_state WHERE key = 'erp_seeded_v1'");
  if (marker && !force) {
    return { seeded: false, reason: 'ERP data already exists.' };
  }

  const now = nowIso();
  await db.run('INSERT INTO document_counters (key, value, updated_at) VALUES (\'PO\', 0, ?) ON CONFLICT (key) DO NOTHING', [now]);
  await db.run('INSERT INTO document_counters (key, value, updated_at) VALUES (\'INV\', 0, ?) ON CONFLICT (key) DO NOTHING', [now]);

  await upsertPermissions(db);
  const roleIds = await upsertRoles(db);
  await upsertUsers(db, roleIds);
  await upsertSuppliersAndIngredients(db);
  await upsertRecipes(db);
  await db.run(
    `INSERT INTO sync_state (key, value) VALUES ('erp_seeded_v1', '1')
     ON CONFLICT (key) DO UPDATE SET value = '1'`,
  );

  return { seeded: true, roles: ROLES.length, users: USERS.length, ingredients: INGREDIENTS.length };
}

module.exports = { seedErpData, ROLES, PERMISSIONS, USERS };
