import { randomUUID } from 'node:crypto';

import { withTransaction } from './client.js';
import { createSurplus, parseDate, STATUS, assertSurplusSafe, UnsafeFoodError } from '../domain/safety.js';
import { routeSurplus, allocateDay, distanceKm } from '../domain/routing.js';

/**
 * Data access, and the one place a transaction is genuinely needed.
 *
 * Everything here is snake_case in, snake_case out, because the domain speaks
 * camelCase and the database does not. The mapping is explicit in each function
 * rather than hidden in a mapper, so a reader can see exactly which column feeds
 * which rule.
 */

const uuid = () => randomUUID();

/**
 * Coerce an ISO string to a Date for a DATETIME column.
 *
 * MySQL will not accept '2026-09-27T21:00:00.000Z' for a DATETIME, only a Date
 * or 'YYYY-MM-DD HH:MM:SS'. Passing the ISO string straight through fails on
 * every single insert, which is why this exists rather than a string replace at
 * the call site.
 *
 * The pool runs with timezone 'Z', so a Date here is written as UTC and read
 * back as UTC. Anything else and a lot's safe-until time shifts by the
 * server's offset, which on a Render host in another region is a real bug that
 * only shows up in production.
 */
function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ suppliers */

export async function createSupplier(pool, input) {
  const id = input.id ?? uuid();
  await pool.query(
    `INSERT INTO suppliers (id, name, kind, contact_name, phone, email, address, city, state, lat, lon)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      String(input.name ?? '').trim(),
      input.kind ?? 'restaurant',
      String(input.contactName ?? '').trim(),
      String(input.phone ?? '').trim(),
      input.email ?? null,
      input.address ?? null,
      input.city ?? '',
      input.state ?? '',
      input.lat ?? null,
      input.lon ?? null,
    ],
  );
  return getSupplier(pool, id);
}

export async function getSupplier(pool, id) {
  const [rows] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function listSuppliers(pool) {
  const [rows] = await pool.query('SELECT * FROM suppliers WHERE active = 1 ORDER BY name');
  return rows;
}

/* ---------------------------------------------------------------------- hubs */

export async function createHub(pool, input) {
  const id = input.id ?? uuid();
  const accepts = Array.isArray(input.accepts) ? input.accepts.join(',') : (input.accepts ?? '');

  await pool.query(
    `INSERT INTO hubs (id, name, organisation, contact_name, phone, address, city, state, lat, lon,
                       daily_capacity_meals, opens_at, closes_at, accepts, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      String(input.name ?? '').trim(),
      String(input.organisation ?? '').trim(),
      String(input.contactName ?? '').trim(),
      String(input.phone ?? '').trim(),
      input.address ?? null,
      input.city ?? '',
      input.state ?? '',
      input.lat ?? null,
      input.lon ?? null,
      Number(input.dailyCapacityMeals ?? 0),
      input.opensAt ?? '09:00:00',
      input.closesAt ?? '21:00:00',
      accepts,
      input.active === false ? 0 : 1,
    ],
  );
  return getHub(pool, id);
}

export async function getHub(pool, id) {
  const [rows] = await pool.query('SELECT * FROM hubs WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function listHubs(pool, { activeOnly = true } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM hubs ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`,
  );
  return rows;
}

/** A hub row in the shape the routing engine expects. */
export function toRoutingShape(hub, supplier) {
  return {
    id: hub.id,
    name: hub.name,
    location: hub.lat === null ? null : { lat: Number(hub.lat), lon: Number(hub.lon) },
    active: hub.active === 1 || hub.active === true,
    dailyCapacityMeals: Number(hub.daily_capacity_meals),
    committedMealsToday: Number(hub.committed_meals_today),
    accepts: hub.accepts ? String(hub.accepts).split(',').filter(Boolean) : [],
    openingHours: {
      // Opening hours are wall clock local to the hub, so they are combined with
      // the pickup window's date rather than treated as absolute instants.
      opensAt: atTimeOnDate(hub.opens_at, supplier?.pickup_opens_at ?? new Date()),
      closesAt: atTimeOnDate(hub.closes_at, supplier?.pickup_opens_at ?? new Date()),
    },
  };
}

function atTimeOnDate(time, date) {
  const d = parseDate(date) ?? new Date();
  const [h, m] = String(time).split(':').map(Number);
  const out = new Date(d);
  // UTC, not local. The pickup window is a UTC instant read from a DATETIME, so
  // building the hub's opening time with setHours would silently shift it by the
  // machine's offset: a hub configured 06:00 to 23:00 became 00:30 to 17:30 on a
  // host in IST, and no hub would ever match an evening pickup. The same code
  // would have behaved differently on a UTC host, which is the worst kind of bug
  // to find in production.
  out.setUTCHours(h || 0, m || 0, 0, 0);
  return out;
}

/* -------------------------------------------------------------------- surplus */

export async function createSurplusRow(pool, input) {
  const record = createSurplus(input);
  const id = record.id;

  await pool.query(
    `INSERT INTO surplus
       (id, supplier_id, title, category, quantity_kg, safe_until, prepared_at,
        requires_hot_holding, requires_chilling, held_at_c,
        pickup_opens_at, pickup_closes_at, pickup_lat, pickup_lon, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      record.supplierId,
      record.title,
      record.category,
      record.quantityKg,
      asDate(record.safeUntil),
      asDate(record.preparedAt),
      record.requiresHotHolding ? 1 : 0,
      record.requiresChilling ? 1 : 0,
      record.heldAtC,
      asDate(record.pickupWindow.opensAt),
      asDate(record.pickupWindow.closesAt),
      input.lat ?? null,
      input.lon ?? null,
      record.status,
    ],
  );
  return getSurplus(pool, id);
}

export async function getSurplus(pool, id) {
  const [rows] = await pool.query('SELECT * FROM surplus WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function listSurplus(pool, { status = null, limit = 100 } = {}) {
  const [rows] = status
    ? await pool.query('SELECT * FROM surplus WHERE status = ? ORDER BY created_at DESC LIMIT ?', [status, limit])
    : await pool.query('SELECT * FROM surplus ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows;
}

/** A surplus row in the shape the safety and routing rules expect. */
export function toPlanShape(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    title: row.title,
    category: row.category,
    quantityKg: Number(row.quantity_kg),
    // Preserved as null when absent. Defaulting it would turn "we were not told"
    // into a date, which is the failure the whole safety rule exists to stop.
    safeUntil: row.safe_until ? new Date(row.safe_until).toISOString() : null,
    preparedAt: row.prepared_at ? new Date(row.prepared_at).toISOString() : null,
    requiresHotHolding: row.requires_hot_holding === 1,
    requiresChilling: row.requires_chilling === 1,
    heldAtC: row.held_at_c === null ? null : Number(row.held_at_c),
    pickupWindow: {
      opensAt: row.pickup_opens_at ? new Date(row.pickup_opens_at).toISOString() : null,
      closesAt: row.pickup_closes_at ? new Date(row.pickup_closes_at).toISOString() : null,
    },
    location: row.pickup_lat === null ? null : { lat: Number(row.pickup_lat), lon: Number(row.pickup_lon) },
    status: row.status,
  };
}

/* ---------------------------------------------------------------- assignments */

/**
 * Route a lot and record the assignment, atomically.
 *
 * Everything below happens inside one transaction, and the ordering is the point:
 *
 *   1. re-read the lot FOR UPDATE, so two coordinators pressing the button at
 *      the same moment cannot both see it as unassigned
 *   2. re-run the safety rules, because a lot can expire while it sits in the
 *      queue and the row was read before the clock moved
 *   3. lock the chosen hub FOR UPDATE, then check and increment its commitment,
 *      so two lots cannot both squeeze into the last of its capacity
 *   4. insert the assignment, whose UNIQUE index on surplus_id is the final
 *      backstop against a second assignment existing
 *
 * Step 2 is the reason this is a transaction and not a helper. Safety checked
 * once at submission and trusted afterwards is a safety check that stops working
 * the moment the food does.
 */
export async function assignSurplus(pool, surplusId, { gramsPerMeal = 250, now = new Date() } = {}) {
  try {
    return await assignInTransaction(pool, surplusId, { gramsPerMeal, now });
  } catch (err) {
    // A safety refusal throws, and the throw rolls the transaction back, which
    // would roll back the refusal record along with everything else. The audit
    // trail is the one thing that must survive, because it is how anybody finds
    // out that a lot was ever offered. So it is written in its own transaction
    // after the rollback, then the typed error is rethrown untouched.
    if (err instanceof UnsafeFoodError) {
      await recordRefusal(pool, surplusId, err.reason);
    }
    throw err;
  }
}

async function recordRefusal(pool, surplusId, reason) {
  try {
    await withTransaction(pool, async (tx) => {
      await tx.query('UPDATE surplus SET status = ?, refusal_reason = ? WHERE id = ?', [
        STATUS.REFUSED,
        reason,
        surplusId,
      ]);
    });
  } catch {
    // Never mask the safety refusal with a bookkeeping failure. The food is
    // still not being routed, which is the part that matters.
  }
}

async function assignInTransaction(pool, surplusId, { gramsPerMeal, now }) {
  return withTransaction(pool, async (tx) => {
    const [lotRows] = await tx.query('SELECT * FROM surplus WHERE id = ? FOR UPDATE', [surplusId]);
    if (lotRows.length === 0) {
      const err = new Error('No such surplus listing');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const lotRow = lotRows[0];

    if (lotRow.status !== STATUS.LISTED) {
      const err = new Error(`Listing is ${lotRow.status}, not ${STATUS.LISTED}`);
      err.code = 'NOT_LISTED';
      throw err;
    }

    const lot = toPlanShape(lotRow);

    // Re-checked here, not trusted from the caller. Throws UnsafeFoodError, which
    // the route turns into a 409 with the reason.
    assertSurplusSafe(lot, now);

    const [hubRows] = await tx.query('SELECT * FROM hubs WHERE active = 1');
    const hubs = hubRows.map((h) => toRoutingShape(h, lotRow));

    const decision = routeSurplus(lot, hubs, { gramsPerMeal, now });

    if (!decision.routed) {
      // Recorded, not deleted. The supplier can see why and fix it.
      await tx.query('UPDATE surplus SET status = ?, refusal_reason = ? WHERE id = ?', [
        decision.outcome === 'refused_unsafe' ? STATUS.REFUSED : lotRow.status,
        decision.reason ?? 'no_eligible_hub',
        surplusId,
      ]);
      return { assigned: false, ...decision };
    }

    // Lock the hub before touching its commitment.
    const [locked] = await tx.query('SELECT * FROM hubs WHERE id = ? FOR UPDATE', [decision.hubId]);
    if (locked.length === 0) {
      const err = new Error('Chosen hub disappeared mid transaction');
      err.code = 'HUB_GONE';
      throw err;
    }

    await tx.query('UPDATE hubs SET committed_meals_today = committed_meals_today + ? WHERE id = ?', [
      decision.meals,
      decision.hubId,
    ]);

    const assignmentId = uuid();
    await tx.query(
      `INSERT INTO assignments (id, surplus_id, hub_id, meals, distance_km, score) VALUES (?,?,?,?,?,?)`,
      [assignmentId, surplusId, decision.hubId, decision.meals, decision.distanceKm, decision.score],
    );

    await tx.query('UPDATE surplus SET status = ? WHERE id = ?', [STATUS.ASSIGNED, surplusId]);

    return { assigned: true, assignmentId, ...decision };
  });
}

/**
 * Route every listed lot in one pass and report what did not fit.
 *
 * Runs in a transaction so the day is allocated against one consistent view of
 * hub capacity rather than a moving target.
 */
export async function allocateAll(pool, { gramsPerMeal = 250, now = new Date() } = {}) {
  return withTransaction(pool, async (tx) => {
    const [lotRows] = await tx.query("SELECT * FROM surplus WHERE status = 'listed' ORDER BY created_at");
    const [hubRows] = await tx.query('SELECT * FROM hubs WHERE active = 1');

    const lots = lotRows.map(toPlanShape);
    const hubs = hubRows.map((h) => toRoutingShape(h, lotRows[0] ?? null));

    const result = allocateDay(lots, hubs, { gramsPerMeal, now });

    // Commit the commitments, once, after the whole day is decided.
    for (const load of result.hubLoad) {
      const [current] = await tx.query('SELECT committed_meals_today FROM hubs WHERE id = ?', [load.hubId]);
      const target = Number(current[0]?.committed_meals_today ?? 0) + (load.committedMealsToday || 0);
      await tx.query('UPDATE hubs SET committed_meals_today = ? WHERE id = ?', [target, load.hubId]);
    }

    for (const placed of result.placed) {
      const lot = lots.find((l) => l.id === placed.surplusId);
      if (!lot) continue;
      const hub = hubs.find((h) => h.id === placed.hubId);
      const assignmentId = uuid();
      await tx.query(
        `INSERT INTO assignments (id, surplus_id, hub_id, meals, distance_km, score) VALUES (?,?,?,?,?,?)`,
        [
          assignmentId,
          placed.surplusId,
          placed.hubId,
          placed.meals,
          lot.location && hub?.location ? Math.round(distanceKm(lot.location, hub.location) * 100) / 100 : null,
          null,
        ],
      );
      await tx.query('UPDATE surplus SET status = ? WHERE id = ?', [STATUS.ASSIGNED, placed.surplusId]);
    }

    return result;
  });
}

export async function getAssignment(pool, id) {
  const [rows] = await pool.query('SELECT * FROM assignments WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function listAssignments(pool, { limit = 100 } = {}) {
  const [rows] = await pool.query(
    `SELECT a.*, s.title, s.category, s.quantity_kg, h.name AS hub_name, sp.name AS supplier_name
       FROM assignments a
       JOIN surplus s   ON s.id = a.surplus_id
       JOIN hubs h      ON h.id = a.hub_id
       JOIN suppliers sp ON sp.id = s.supplier_id
      ORDER BY a.created_at DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

/* ----------------------------------------------------------------- collections */

export async function recordCollection(pool, input) {
  const { assignmentId, status = 'collected', collectedKg = null, collectedMeals = null, notes = null, now = new Date() } = input;

  return withTransaction(pool, async (tx) => {
    // supplier_id comes from the surplus row, joined here. It is NOT NULL on the
    // collection, so inserting a placeholder and patching it afterwards fails at
    // the column rather than at a line of application logic.
    const [rows] = await tx.query(
      `SELECT a.*, s.supplier_id, s.id AS lot_id
         FROM assignments a
         JOIN surplus s ON s.id = a.surplus_id
        WHERE a.id = ?`,
      [assignmentId],
    );
    if (rows.length === 0) {
      const err = new Error('No such assignment');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const assignment = rows[0];

    const [existing] = await tx.query('SELECT id FROM collections WHERE assignment_id = ?', [assignmentId]);
    if (existing.length > 0) {
      // The unique index would catch this anyway, but a named error tells the
      // caller what actually happened instead of surfacing a driver code.
      const err = new Error('This assignment has already been logged as a collection');
      err.code = 'ALREADY_COLLECTED';
      throw err;
    }

    const id = uuid();
    const collectedAt = status === 'collected' ? now : null;

    await tx.query(
      `INSERT INTO collections (id, assignment_id, hub_id, supplier_id, status, collected_kg, collected_meals, collected_at, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, assignmentId, assignment.hub_id, assignment.supplier_id, status, collectedKg, collectedMeals, collectedAt, notes],
    );

    // Give the meal back. A lot that is collected or cancelled no longer holds
    // capacity, otherwise the hub is short a meal that nothing will ever fill.
    if (status === 'collected') {
      await tx.query('UPDATE hubs SET committed_meals_today = GREATEST(0, committed_meals_today - ?) WHERE id = ?', [
        assignment.meals,
        assignment.hub_id,
      ]);
      await tx.query('UPDATE surplus SET status = ? WHERE id = ?', [STATUS.COLLECTED, assignment.lot_id]);
      await tx.query("UPDATE assignments SET status = 'collected' WHERE id = ?", [assignmentId]);
    } else if (status === 'cancelled' || status === 'missed') {
      await tx.query('UPDATE hubs SET committed_meals_today = GREATEST(0, committed_meals_today - ?) WHERE id = ?', [
        assignment.meals,
        assignment.hub_id,
      ]);
      await tx.query('UPDATE assignments SET status = ? WHERE id = ?', [status, assignmentId]);
    }

    return getCollection(pool, id);
  });
}

export async function getCollection(pool, id) {
  const [rows] = await pool.query('SELECT * FROM collections WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function listCollections(pool, { limit = 200 } = {}) {
  const [rows] = await pool.query(
    `SELECT c.*, a.surplus_id, a.meals AS assigned_meals, h.name AS hub_name, s.category, s.quantity_kg
       FROM collections c
       JOIN assignments a ON a.id = c.assignment_id
       JOIN hubs h        ON h.id = c.hub_id
       JOIN surplus s     ON s.id = a.surplus_id
      ORDER BY c.created_at DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

export { UnsafeFoodError };
