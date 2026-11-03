const crypto = require('node:crypto');
const { nowIso } = require('./db');

const photo = {
  doro: 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=800&q=82',
  pasta: 'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?auto=format&fit=crop&w=800&q=82',
  salmon: 'https://images.unsplash.com/photo-1467003909585-2f8a72700288?auto=format&fit=crop&w=800&q=82',
  salad: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=800&q=82',
  burger: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=800&q=82',
  soup: 'https://images.unsplash.com/photo-1547592166-23ac45744acd?auto=format&fit=crop&w=800&q=82',
  coffee: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=800&q=82',
  dessert: 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?auto=format&fit=crop&w=800&q=82',
  juice: 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=800&q=82',
  fries: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=800&q=82',
};

const categories = [
  ['Breakfast', 1],
  ['Lunch', 2],
  ['Pasta', 3],
  ['Soups', 4],
  ['Drinks', 5],
  ['Burgers', 6],
  ['Desserts', 7],
  ['Sides', 8],
];

const items = [
  ['Doro wat & injera', 'Lunch', 420, 'Kitchen', photo.doro, 'Slow-cooked chicken, berbere, soft-boiled egg', 1],
  ['Wild mushroom tagliatelle', 'Pasta', 385, 'Kitchen', photo.pasta, 'Hand-cut pasta, forest mushrooms, parmesan', 2],
  ['Citrus grilled salmon', 'Lunch', 620, 'Kitchen', photo.salmon, 'Charred lemon, herbs, seasonal greens', 3],
  ['Garden harvest bowl', 'Breakfast', 265, 'Kitchen', photo.salad, 'Avocado, tender greens, toasted seeds', 4],
  ['House smash burger', 'Burgers', 390, 'Kitchen', photo.burger, 'Dry-aged beef, aged cheddar, house sauce', 5],
  ['Roasted tomato soup', 'Soups', 195, 'Kitchen', photo.soup, 'Slow-roasted tomato, basil, sourdough', 6],
  ['Flat white', 'Drinks', 115, 'Bar', photo.coffee, 'Double espresso, silky steamed milk', 7],
  ['Cardamom tiramisu', 'Desserts', 220, 'Kitchen', photo.dessert, 'Mascarpone, espresso, green cardamom', 8],
  ['Mango & ginger juice', 'Drinks', 145, 'Bar', photo.juice, 'Fresh mango, ginger, a little lime', 9],
  ['Rosemary shoestring fries', 'Sides', 130, 'Kitchen', photo.fries, 'Crisp potatoes, rosemary salt, aioli', 10],
];

async function seedDemoData(db, options = {}) {
  const force = Boolean(options.force);
  const existing = await db.get('SELECT COUNT(*) AS count FROM menu_items');
  if (Number(existing.count) > 0 && !force) {
    return { seeded: false, reason: 'menu already has items' };
  }

  const now = nowIso();
  const categoryIds = {};

  for (const [name, sort] of categories) {
    const row = await db.get(
      `INSERT INTO menu_categories (sync_id, name, sort, active, updated_at, deleted)
       VALUES (?, ?, ?, 1, ?, 0)
       ON CONFLICT (sync_id) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [crypto.randomUUID(), name, sort, now],
    );
    categoryIds[name] = row.id;
  }

  for (const [name, category, price, station, image, description, sort] of items) {
    await db.run(
      `INSERT INTO menu_items
         (sync_id, category_id, category_sync_id, name, description, price, image_url, station,
          available, sold_out, featured, sort_order, updated_at, deleted)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 0)`,
      [crypto.randomUUID(), categoryIds[category], name, description, price, image, station, sort, now],
    );
  }

  const tableExisting = await db.get('SELECT COUNT(*) AS count FROM dining_tables');
  if (Number(tableExisting.count) === 0) {
    for (let i = 1; i <= 12; i += 1) {
      const number = String(i).padStart(2, '0');
      await db.run(
        `INSERT INTO dining_tables (sync_id, number, name, capacity, status, qr_token, updated_at, deleted)
         VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?, 0)`,
        [crypto.randomUUID(), number, `Table ${number}`, i % 3 === 0 ? 6 : 4, crypto.randomUUID(), now],
      );
    }
  }

  return { seeded: true, categories: categories.length, items: items.length, tables: 12 };
}

module.exports = { seedDemoData };
