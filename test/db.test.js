import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createPool, migrate, reset, ensureDatabase, ping } from '../src/db/client.js';
import {
  createSupplier,
  createHub,
  createSurplusRow,
  assignSurplus,
  allocateAll,
  recordCollection,
  listSurplus,
  getSurplus,
  listHubs,
} from '../src/db/repo.js';

/**
 * These run against the real MySQL server on localhost, not a mock and not an
 * in-memory substitute. That is the whole reason for using MySQL here rather
 * than the PGlite trick the sibling project uses: the paper names MySQL, and
 * the constraints below are MySQL behaviour worth proving on MySQL.
 *
 * The most important ones are the ones a mock could never have caught:
 *
 *   - a hub cannot be committed beyond its own capacity (CHECK)
 *   - a lot cannot be assigned twice (UNIQUE)
 *   - a handover cannot be logged twice (UNIQUE)
 *   - a collection marked collected must carry a timestamp (CHECK)
 */

let pool;

const NOW = new Date('2026-09-27T18:00:00Z');
const at = (mins) => new Date(NOW.getTime() + mins * 60_000);

const supplier = (over = {}) => ({
  name: 'Banjara Cafe',
  kind: 'restaurant',
  contactName: 'Asha',
  phone: `98765${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
  city: 'Hyderabad',
  state: 'Telangana',
  lat: 17.4126,
  lon: 78.4347,
  ...over,
});

const hub = (over = {}) => ({
  name: 'Community Kitchen',
  organisation: 'Shelter Trust',
  contactName: 'Ravi',
  phone: `90000${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`,
  city: 'Hyderabad',
  state: 'Telangana',
  lat: 17.3899,
  lon: 78.4983,
  dailyCapacityMeals: 200,
  opensAt: '06:00:00',
  closesAt: '23:00:00',
  accepts: ['prepared', 'bakery', 'produce', 'dairy', 'meat', 'other'],
  ...over,
});

const lot = (supplierId, over = {}) => ({
  supplierId,
  title: 'Vegetable curry',
  category: 'prepared',
  quantityKg: 5,
  safeUntil: at(180).toISOString(),
  preparedAt: at(-30).toISOString(),
  pickupWindow: { opensAt: at(30).toISOString(), closesAt: at(150).toISOString() },
  lat: 17.4126,
  lon: 78.4347,
  ...over,
});

before(async () => {
  await ensureDatabase({ database: 'foodforward_test' });
  pool = createPool({ database: 'foodforward_test' });
  await migrate(pool);
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await reset(pool);
});

describe('the schema applies to a real server', () => {
  test('the connection works and every table exists', async () => {
    assert.equal(await ping(pool), true);
    const [rows] = await pool.query('SHOW TABLES');
    const names = rows.map((r) => Object.values(r)[0]);
    for (const t of ['suppliers', 'hubs', 'surplus', 'assignments', 'collections']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });

  test('migrating twice is safe', async () => {
    // The schema is written to be idempotent so a deploy can run it without
    // thinking about it first.
    await migrate(pool);
    await migrate(pool);
    assert.equal(await ping(pool), true);
  });
});

describe('a hub cannot be committed beyond its own capacity', () => {
  test('the database refuses it, not just the application', async () => {
    // Belt and braces. The routing engine refuses to place a lot it will not fit,
    // but a stray UPDATE must not be able to overfill a hub either.
    const h = await createHub(pool, hub({ dailyCapacityMeals: 10, committedMealsToday: 0 }));
    await pool.query('UPDATE hubs SET committed_meals_today = 10 WHERE id = ?', [h.id]);
    await assert.rejects(
      () => pool.query('UPDATE hubs SET committed_meals_today = 11 WHERE id = ?', [h.id]),
      'the CHECK constraint should have refused 11 meals into a 10 meal hub',
    );
    const [after] = await pool.query('SELECT committed_meals_today FROM hubs WHERE id = ?', [h.id]);
    assert.equal(Number(after[0].committed_meals_today), 10, 'the refused write changed nothing');
  });

  test('a hub with impossible opening hours is refused', async () => {
    await assert.rejects(() => createHub(pool, hub({ opensAt: '21:00:00', closesAt: '09:00:00' })));
  });
});

describe('surplus with no safe-until time is stored but never routed', () => {
  test('the row is accepted, because recording the absence is the point', async () => {
    // Rejecting it at the database would stop a supplier listing anything, which
    // is a different and equally unhelpful failure. The refusal belongs in
    // routing, where the reason can be shown to somebody.
    const s = await createSupplier(pool, supplier());
    const row = await createSurplusRow(pool, lot(s.id, { safeUntil: null }));
    assert.equal(row.safe_until, null, 'the absence is stored, not defaulted');
  });

  test('and it cannot be assigned', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub());
    const row = await createSurplusRow(pool, lot(s.id, { safeUntil: null }));

    await assert.rejects(
      () => assignSurplus(pool, row.id, { now: NOW }),
      (err) => err.name === 'UnsafeFoodError' && err.reason === 'no_expiry_recorded',
    );

    const after = await getSurplus(pool, row.id);
    // Recorded as refused, not left as listed and not deleted. The safety
    // refusal throws, and that throw rolls the transaction back, so the refusal
    // record is written in its own transaction afterwards. Without that the
    // audit trail vanished at exactly the moment anybody needed to know the lot
    // had been offered.
    assert.equal(after.status, 'refused');
    assert.equal(after.refusal_reason, 'no_expiry_recorded');

    const [count] = await pool.query('SELECT COUNT(*) AS c FROM assignments WHERE surplus_id = ?', [row.id]);
    assert.equal(Number(count[0].c), 0, 'and no assignment was created');
  });
});

describe('a lot can never be assigned twice', () => {
  test('the unique index refuses a second assignment', async () => {
    const s = await createSupplier(pool, supplier());
    const h = await createHub(pool, hub());
    const row = await createSurplusRow(pool, lot(s.id));

    await assignSurplus(pool, row.id, { now: NOW });

    // Straight at the table, bypassing every line of application logic. This is
    // what makes the guarantee real rather than a convention.
    await assert.rejects(
      () =>
        pool.query('INSERT INTO assignments (id, surplus_id, hub_id, meals) VALUES (?,?,?,?)', [
          'ffffffff-ffff-ffff-ffff-ffffffffffff',
          row.id,
          h.id,
          5,
        ]),
      'the UNIQUE index on surplus_id should have refused this',
    );
  });

  test('assigning an already assigned lot is refused by the application too', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub());
    const row = await createSurplusRow(pool, lot(s.id));

    const first = await assignSurplus(pool, row.id, { now: NOW });
    assert.equal(first.assigned, true);

    await assert.rejects(
      () => assignSurplus(pool, row.id, { now: NOW }),
      (err) => err.code === 'NOT_LISTED',
    );

    const [count] = await pool.query('SELECT COUNT(*) AS c FROM assignments WHERE surplus_id = ?', [row.id]);
    assert.equal(Number(count[0].c), 1, 'still exactly one assignment');
  });

  test('expired food is refused and the refusal is recorded', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub({ dailyCapacityMeals: 9999 }));
    const row = await createSurplusRow(
      pool,
      lot(s.id, { safeUntil: at(-10).toISOString() }),
    );

    await assert.rejects(() => assignSurplus(pool, row.id, { now: NOW }));

    const after = await getSurplus(pool, row.id);
    assert.equal(after.status, 'refused');
    assert.equal(after.refusal_reason, 'past_safe_use', 'the reason survives for the audit trail');

    const [count] = await pool.query('SELECT COUNT(*) AS c FROM assignments');
    assert.equal(Number(count[0].c), 0, 'and no assignment exists for it');
  });

  test('a lot that expires while queued is refused at assignment time', async () => {
    // The transaction re-reads and re-checks. A lot safe at submission is not
    // safe an hour later, and that is the whole reason safety runs inside the
    // transaction rather than once at the API edge.
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub({ dailyCapacityMeals: 9999 }));
    const row = await createSurplusRow(pool, lot(s.id, { safeUntil: at(30).toISOString() }));

    const later = at(60);
    await assert.rejects(
      () => assignSurplus(pool, row.id, { now: later }),
      (err) => err.reason === 'past_safe_use',
    );
  });
});

describe('a handover cannot be logged twice', () => {
  test('the second attempt is refused by name', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub());
    const row = await createSurplusRow(pool, lot(s.id));
    const assignment = await assignSurplus(pool, row.id, { now: NOW });

    await recordCollection(pool, { assignmentId: assignment.assignmentId, collectedKg: 5, now: at(60) });

    await assert.rejects(
      () => recordCollection(pool, { assignmentId: assignment.assignmentId, collectedKg: 5, now: at(70) }),
      (err) => err.code === 'ALREADY_COLLECTED',
    );

    const [rows] = await pool.query('SELECT COUNT(*) AS c FROM collections WHERE assignment_id = ?', [
      assignment.assignmentId,
    ]);
    assert.equal(Number(rows[0].c), 1, 'the impact total cannot be counted twice');
  });

  test('a collection marked collected must carry a timestamp', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub());
    const row = await createSurplusRow(pool, lot(s.id));
    const assignment = await assignSurplus(pool, row.id, { now: NOW });

    // Straight at the table again. An impact figure with no timestamp cannot be
    // placed in a reporting period, so the database refuses the shape.
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO collections (id, assignment_id, hub_id, status, collected_kg)
         VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', ?, ?, 'collected', 5)`,
        [assignment.assignmentId, assignment.hubId],
      ),
    );
  });

  test('collecting releases the hub commitment', async () => {
    const s = await createSupplier(pool, supplier());
    const h = await createHub(pool, hub({ dailyCapacityMeals: 200 }));
    const row = await createSurplusRow(pool, lot(s.id));
    const assignment = await assignSurplus(pool, row.id, { now: NOW });

    const [committed] = await pool.query('SELECT committed_meals_today FROM hubs WHERE id = ?', [h.id]);
    assert.ok(Number(committed[0].committed_meals_today) > 0, 'the lot holds capacity while assigned');

    await recordCollection(pool, { assignmentId: assignment.assignmentId, collectedKg: 5, now: at(60) });

    const [after] = await pool.query('SELECT committed_meals_today FROM hubs WHERE id = ?', [h.id]);
    assert.equal(Number(after[0].committed_meals_today), 0, 'and releases it once the food actually moved');
  });

  test('a cancelled collection also releases capacity', async () => {
    const s = await createSupplier(pool, supplier());
    const h = await createHub(pool, hub({ dailyCapacityMeals: 200 }));
    const row = await createSurplusRow(pool, lot(s.id));
    const assignment = await assignSurplus(pool, row.id, { now: NOW });

    await recordCollection(pool, { assignmentId: assignment.assignmentId, status: 'cancelled', now: at(60) });

    const [after] = await pool.query('SELECT committed_meals_today FROM hubs WHERE id = ?', [h.id]);
    assert.equal(Number(after[0].committed_meals_today), 0, 'otherwise the meal is lost to nobody');
  });
});

describe('a days allocation respects capacity against live rows', () => {
  test('lots spread across hubs and nothing is over capacity', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub({ name: 'Hub A', dailyCapacityMeals: 60, lat: 17.4126, lon: 78.4347 }));
    await createHub(pool, hub({ name: 'Hub B', dailyCapacityMeals: 60, lat: 17.3899, lon: 78.4983 }));

    // 5kg is 20 meals. Six lots is 120 against 120 of capacity.
    for (let i = 0; i < 6; i += 1) {
      await createSurplusRow(pool, lot(s.id, { quantityKg: 5, title: `lot ${i}` }));
    }

    const result = await allocateAll(pool, { now: NOW });
    assert.equal(result.unplaced.length, 0, `unplaced: ${JSON.stringify(result.unplaced)}`);

    const [hubs] = await pool.query('SELECT name, daily_capacity_meals, committed_meals_today FROM hubs');
    for (const h of hubs) {
      assert.ok(
        Number(h.committed_meals_today) <= Number(h.daily_capacity_meals),
        `${h.name} committed ${h.committed_meals_today} of ${h.daily_capacity_meals}`,
      );
    }

    const [count] = await pool.query('SELECT COUNT(*) AS c FROM assignments');
    assert.equal(Number(count[0].c), 6);
  });

  test('lots that do not fit are reported, not dropped', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub({ dailyCapacityMeals: 20 }));

    for (let i = 0; i < 5; i += 1) {
      await createSurplusRow(pool, lot(s.id, { quantityKg: 5, title: `lot ${i}` }));
    }

    const result = await allocateAll(pool, { now: NOW });
    assert.equal(result.placed.length + result.unplaced.length, 5, 'every lot is accounted for');
    assert.equal(result.unplaced.length, 4, 'only one 20 meal lot fits in a 20 meal hub');
  });

  test('an expired lot is never placed even with free capacity', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub({ dailyCapacityMeals: 9999 }));
    await createSurplusRow(pool, lot(s.id, { quantityKg: 1, safeUntil: at(-5).toISOString() }));

    const result = await allocateAll(pool, { now: NOW });
    assert.equal(result.placed.length, 0);
    assert.equal(result.unplaced.length, 1);
    assert.equal(result.unplaced[0].reason, 'past_safe_use');
  });
});

describe('a hub closed for the pickup window is skipped', () => {
  test('a daytime only hub does not take an evening lot', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub({ opensAt: '09:00:00', closesAt: '17:00:00', dailyCapacityMeals: 9999 }));
    const row = await createSurplusRow(
      pool,
      lot(s.id, { pickupWindow: { opensAt: at(60).toISOString(), closesAt: at(150).toISOString() } }),
    );

    const result = await assignSurplus(pool, row.id, { now: NOW });
    assert.equal(result.assigned, false);
    assert.equal(result.reason, 'all_hubs_declined');
  });
});

describe('listing and reading', () => {
  test('a supplier, hub and lot round trip through the database', async () => {
    const s = await createSupplier(pool, supplier({ name: 'Round Trip Cafe' }));
    const h = await createHub(pool, hub({ name: 'Round Trip Kitchen' }));
    const row = await createSurplusRow(pool, lot(s.id, { title: 'Round Trip Curry' }));

    const fetched = await getSurplus(pool, row.id);
    assert.equal(fetched.title, 'Round Trip Curry');
    assert.equal(Number(fetched.quantity_kg), 5);

    const hubs = await listHubs(pool);
    assert.ok(hubs.some((x) => x.name === 'Round Trip Kitchen'));
  });

  test('a duplicate supplier phone is refused', async () => {
    const phone = '98765000001';
    await createSupplier(pool, supplier({ phone }));
    await assert.rejects(() => createSupplier(pool, supplier({ phone })), 'phone should be unique');
  });

  test('listed surplus can be filtered by status', async () => {
    const s = await createSupplier(pool, supplier());
    await createHub(pool, hub());
    const row = await createSurplusRow(pool, lot(s.id));
    await assignSurplus(pool, row.id, { now: NOW });

    const listed = await listSurplus(pool, { status: 'listed' });
    const assigned = await listSurplus(pool, { status: 'assigned' });
    assert.equal(listed.length, 0);
    assert.equal(assigned.length, 1);
  });
});
