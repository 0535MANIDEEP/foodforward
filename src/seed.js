/**
 * Seed data.
 *
 * This is SAMPLE data and the file says so at the top of every printed line,
 * because a seed script is exactly where invented numbers leak into a
 * demonstration and then get quoted as results. Nothing in here is a real
 * rescue, a real supplier, a real hub, or a real measurement.
 *
 * The CO2e figures that the impact report prints are a standard emissions
 * factor applied to weight, not a measurement, and the report says so.
 *
 * Safe. TRUNCATE rather than DELETE, so a rerun cannot half fail and leave a
 * database in a state nobody can reason about.
 */

import { createPool, migrate, ensureDatabase, reset } from './db/client.js';
import { createSupplier, createHub, createSurplusRow, assignSurplus, allocateAll, recordCollection } from './db/repo.js';

const MIN = 60_000;
const hoursAgo = (h) => new Date(Date.now() - h * 60 * MIN);
const hoursAhead = (h) => new Date(Date.now() + h * 60 * MIN);

const SUPPLIERS = [
  { name: 'Banjara Cafe', kind: 'restaurant', contactName: 'Asha Rao', phone: '9000001001', city: 'Hyderabad', state: 'Telangana', lat: 17.4126, lon: 78.4347 },
  { name: 'Paradise Biryani, Banjara Hills', kind: 'restaurant', contactName: 'Imran Sheikh', phone: '9000001002', city: 'Hyderabad', state: 'Telangana', lat: 17.4156, lon: 78.4276 },
  { name: 'Cloud Nine Banquets', kind: 'event', contactName: 'Praveen Kumar', phone: '9000001003', city: 'Hyderabad', state: 'Telangana', lat: 17.3998, lon: 78.4498 },
  { name: 'Fresh Fold Bakery', kind: 'restaurant', contactName: 'Lakshmi Menon', phone: '9000001004', city: 'Secunderabad', state: 'Telangana', lat: 17.4399, lon: 78.4983 },
  { name: 'Sagar Caterers', kind: 'caterer', contactName: 'Vijay Bhatt', phone: '9000001005', city: 'Hyderabad', state: 'Telangana', lat: 17.4235, lon: 78.4722 },
];

const HUBS = [
  { name: 'Community Kitchen, Charminar', organisation: 'Shelter Trust', contactName: 'Ravi Prasad', phone: '9100002001', city: 'Hyderabad', state: 'Telangana', lat: 17.3616, lon: 78.4747, dailyCapacityMeals: 120, opensAt: '06:00:00', closesAt: '23:00:00' },
  { name: 'Asha Bhavan', organisation: 'Night Shelter Network', contactName: 'Sunita Bai', phone: '9100002002', city: 'Hyderabad', state: 'Telangana', lat: 17.3899, lon: 78.4983, dailyCapacityMeals: 80, opensAt: '18:00:00', closesAt: '23:30:00', accepts: ['prepared', 'bakery', 'dairy', 'other'] },
  { name: 'Anganwadi Centre, Secunderabad', organisation: 'Women and Child Welfare', contactName: 'Fatima Sultana', phone: '9100002003', city: 'Secunderabad', state: 'Telangana', lat: 17.4461, lon: 78.4869, dailyCapacityMeals: 100, opensAt: '07:00:00', closesAt: '20:00:00', accepts: ['prepared', 'produce', 'dairy', 'other'] },
  { name: 'Sunrise Day Centre', organisation: 'Hope Foundation', contactName: 'Deepak Anand', phone: '9100002004', city: 'Hyderabad', state: 'Telangana', lat: 17.4213, lon: 78.5067, dailyCapacityMeals: 60, opensAt: '06:30:00', closesAt: '22:00:00' },
];

// Each entry is a scenario worth demonstrating, including the ones that must
// not route. A seed that only contains successes teaches nothing about the part
// of the system that matters.
const LOTS = [
  { s: 0, title: 'Vegetable biryani and raita', category: 'prepared', kg: 12, safeIn: 3, opensIn: 0.5, closesIn: 3 },
  { s: 1, title: 'Mutton curry, 4 kg', category: 'prepared', kg: 4, safeIn: 4, opensIn: 1, closesIn: 4 },
  { s: 2, title: 'Wedding buffet, mixed', category: 'prepared', kg: 28, safeIn: 2.5, opensIn: 0.25, closesIn: 2.5 },
  { s: 3, title: 'Day-old bread and rolls', category: 'bakery', kg: 9, safeIn: 20, opensIn: 1, closesIn: 8 },
  { s: 4, title: 'Fruit platters', category: 'produce', kg: 15, safeIn: 26, opensIn: 2, closesIn: 10 },
  { s: 0, title: 'Curd and milk', category: 'dairy', kg: 6, safeIn: 30, opensIn: 1, closesIn: 6 },
  { s: 2, title: 'Cooked rice, held since service', category: 'prepared', kg: 7, safeIn: 1.5, opensIn: 0.2, closesIn: 2 },

  // No safe-until time recorded. Refused. A supplier not knowing is not the
  // same as a supplier knowing it is fine, and this row is the proof.
  { s: 1, title: 'Staff meal, expiry not recorded', category: 'prepared', kg: 5, safeIn: null, opensIn: 1, closesIn: 5 },

  // Already past its safe-until time. Refused.
  { s: 3, title: 'Pastry boxes, this morning', category: 'bakery', kg: 4, safeIn: -1, opensIn: 0.5, closesIn: 4 },

  // Chilled, so it needs a hub that can actually refrigerate it.
  { s: 4, title: 'Chilled salad bowls', category: 'prepared', kg: 8, safeIn: 18, opensIn: 1, closesIn: 5, requiresChilling: true, heldAtC: 6 },
];

async function seed() {
  await ensureDatabase();
  const pool = createPool();
  await migrate(pool);

  const shouldReset = process.argv.includes('--reset');
  if (shouldReset) {
    await reset(pool);
    console.log('  reset: every table dropped and recreated');
  }

  console.log('  SAMPLE DATA. None of this is a real rescue or a real measurement.\n');

  const suppliers = [];
  for (const s of SUPPLIERS) {
    suppliers.push(await createSupplier(pool, s));
  }
  console.log(`  ${suppliers.length} suppliers`);

  const hubs = [];
  for (const h of HUBS) {
    hubs.push(await createHub(pool, h));
  }
  console.log(`  ${hubs.length} hubs`);

  const created = [];
  for (const l of LOTS) {
    const supplier = suppliers[l.s];
    const row = await createSurplusRow(pool, {
      supplierId: supplier.id,
      title: l.title,
      category: l.category,
      quantityKg: l.kg,
      safeUntil: l.safeIn === null ? null : hoursAhead(l.safeIn).toISOString(),
      preparedAt: hoursAgo(3).toISOString(),
      requiresChilling: l.requiresChilling ?? false,
      heldAtC: l.heldAtC ?? null,
      pickupWindow: {
        opensAt: hoursAhead(l.opensIn).toISOString(),
        closesAt: hoursAhead(l.closesIn).toISOString(),
      },
      lat: supplier.lat,
      lon: supplier.lon,
    });
    created.push({
      id: row.id,
      title: l.title,
      // Recorded as a flag here rather than re-derived from the dates later.
      // safeIn is hours from now, so trying to read a time off it is wrong, and
      // the refusal cases are already known at this point.
      expectRefusal: l.safeIn === null || l.safeIn < 0,
    });
  }
  console.log(`  ${created.length} surplus listings`);

  // Batch allocation, which is the day-level path and the one that reports
  // rather than drops whatever does not fit.
  const result = await allocateAll(pool);
  console.log(`  allocated: ${result.placed.length} placed, ${result.unplaced.length} not placed`);

  // unplaced carries the surplus id, not the lot, so the title is looked up.
  // Printing an id to a human running a demo is useless.
  const titleOf = (surplusId) => created.find((c) => c.id === surplusId)?.title ?? surplusId;

  for (const u of result.unplaced) {
    console.log(`    not placed: ${titleOf(u.surplusId)} (${u.reason})`);
  }

  // Log a few handovers so the impact report has something true to show. Only
  // assignments that actually exist are logged, and only once each.
  const assignments = await pool.query('SELECT id, surplus_id, meals FROM assignments ORDER BY created_at');
  let logged = 0;
  for (const [i, a] of assignments[0].entries()) {
    if (i >= 3) break;
    try {
      await recordCollection(pool, {
        assignmentId: a.id,
        status: 'collected',
        // 250 g a serving, so meals x 0.25 is the weight in kg. Getting this
        // wrong by a factor of ten makes the impact page claim 88 meals were
        // delivered in 2.2 kg, which is the kind of contradiction that destroys
        // trust in every other number on the page.
        collectedKg: Math.round(Number(a.meals) * 0.25 * 100) / 100,
        collectedMeals: a.meals,
        now: hoursAgo(i + 1),
        notes: 'SAMPLE handover',
      });
      logged += 1;
    } catch (err) {
      console.log(`    skipped a handover: ${err.message}`);
    }
  }
  console.log(`  ${logged} handovers logged (SAMPLE)`);

  // Demonstrate the two refusals by attempting them, so the audit trail has
  // entries and the board shows the reason rather than an empty list.
  let refused = 0;
  for (const c of created.filter((x) => x.expectRefusal)) {
    try {
      await assignSurplus(pool, c.id);
    } catch (err) {
      refused += 1;
      console.log(`    refused: ${c.title} (${err.reason})`);
    }
  }
  console.log(`  ${refused} refused, with the reason recorded`);

  const [impact] = await pool.query('SELECT COUNT(*) AS n FROM collections WHERE status = "collected"');
  console.log(`\n  SAMPLE impact: ${impact[0].n} completed handovers. Visit /api/impact.\n`);

  await pool.end();
}

seed().catch((err) => {
  console.error('  seed failed:', err.message);
  process.exit(1);
});
