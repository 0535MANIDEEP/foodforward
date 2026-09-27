import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createPool, migrate, reset, ensureDatabase } from '../src/db/client.js';
import { createHub as createHubRow } from '../src/db/repo.js';
import { createApp } from '../src/app.js';

/**
 * Driven over a real socket against a real MySQL, because calling handlers
 * directly skips the middleware chain and cannot catch a body limit, a CORS
 * refusal or a 404 that never fires.
 */

let pool;
let server;
let base;

const NOW = new Date();
const at = (mins) => new Date(NOW.getTime() + mins * 60_000).toISOString();

before(async () => {
  await ensureDatabase({ database: 'foodforward_api_test' });
  pool = createPool({ database: 'foodforward_api_test' });
  await migrate(pool);

  const app = createApp({ pool, gramsPerMeal: 250, allowedOrigins: ['https://app.example.test'] });
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

beforeEach(async () => {
  await reset(pool);
});

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* left null so a non JSON response is visible as one */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

let seq = 0;
const makeSupplier = async (over = {}) => {
  seq += 1;
  const r = await call('/api/suppliers', {
    method: 'POST',
    body: {
      name: 'Test Kitchen',
      contactName: 'Asha',
      phone: `98765${String(seq).padStart(6, '0')}`,
      city: 'Hyderabad',
      state: 'Telangana',
      lat: 17.4126,
      lon: 78.4347,
      ...over,
    },
  });
  assert.equal(r.status, 201, r.text);
  return r.body.supplier;
};

const makeHub = async (over = {}) => {
  const r = await call('/api/hubs', {
    method: 'POST',
    body: {
      name: 'Community Kitchen',
      organisation: 'Shelter Trust',
      contactName: 'Ravi',
      phone: `90000${String(seq++).padStart(5, '0')}`,
      city: 'Hyderabad',
      state: 'Telangana',
      lat: 17.3899,
      lon: 78.4983,
      dailyCapacityMeals: 200,
      opensAt: '06:00:00',
      closesAt: '23:00:00',
      accepts: ['prepared', 'bakery', 'produce', 'dairy', 'meat', 'other'],
      ...over,
    },
  });
  assert.equal(r.status, 201, r.text);
  return r.body.hub;
};

const makeLot = async (supplierId, over = {}) => {
  const r = await call('/api/surplus', {
    method: 'POST',
    body: {
      supplierId,
      title: 'Vegetable curry',
      category: 'prepared',
      quantityKg: 5,
      safeUntil: at(180),
      preparedAt: at(-30),
      pickupWindow: { opensAt: at(30), closesAt: at(150) },
      lat: 17.4126,
      lon: 78.4347,
      ...over,
    },
  });
  assert.equal(r.status, 201, r.text);
  return r.body.surplus;
};

describe('meta endpoints state what this is and is not', () => {
  test('about carries the safety rule and admits there is no auth', async () => {
    const r = await call('/api/about');
    assert.equal(r.status, 200);
    assert.match(r.body.safetyRule, /never routed/i);
    assert.match(r.body.authentication, /none/i);
    assert.equal(r.body.paper.id, 'JETIR2404570');
    assert.equal(r.body.paper.pages, 'f645-f647');
  });

  test('health reports the database it actually reached', async () => {
    const r = await call('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.database, 'ok');
  });
});

describe('the safety refusal reaches the client as a 409 with a reason', () => {
  test('expired surplus is refused and the reason travels with it', async () => {
    const s = await makeSupplier();
    await makeHub({ dailyCapacityMeals: 9999 });
    const lot = await makeLot(s.id, { safeUntil: at(-5) });

    const r = await call(`/api/surplus/${lot.id}/assign`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'past_safe_use');
    assert.ok(Array.isArray(r.body.reasons) && r.body.reasons.length > 0);
  });

  test('surplus with no safe-until time is refused the same way', async () => {
    const s = await makeSupplier();
    await makeHub();
    const lot = await makeLot(s.id, { safeUntil: null });

    const r = await call(`/api/surplus/${lot.id}/assign`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'no_expiry_recorded');
  });

  test('absent is not turned into a date on the way in', async () => {
    // A default here would be the whole bug: the routing engine would then trust
    // a date nobody supplied.
    const s = await makeSupplier();
    const lot = await makeLot(s.id, { safeUntil: null });
    assert.equal(lot.safeUntil, null);
  });

  test('the listing endpoint shows the safety verdict before anyone asks', async () => {
    const s = await makeSupplier();
    const lot = await makeLot(s.id, { safeUntil: at(-5) });
    const r = await call(`/api/surplus/${lot.id}`);
    assert.equal(r.body.safety.safe, false);
    assert.equal(r.body.safety.reasons[0].reason, 'past_safe_use');
  });
});

describe('the happy path works end to end', () => {
  test('a safe lot is assigned to a hub', async () => {
    const s = await makeSupplier();
    const hub = await makeHub({ dailyCapacityMeals: 200 });
    const lot = await makeLot(s.id);

    const r = await call(`/api/surplus/${lot.id}/assign`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.assigned, true);
    assert.equal(r.body.hubId, hub.id);
    assert.equal(r.body.meals, 20, '5kg at 250g');
    assert.ok(r.body.distanceKm > 0);
  });

  test('a collection releases capacity and shows up in impact', async () => {
    const s = await makeSupplier();
    const h = await makeHub({ dailyCapacityMeals: 200 });
    const lot = await makeLot(s.id);
    const assignment = await call(`/api/surplus/${lot.id}/assign`, { method: 'POST' });

    const before = await call('/api/hubs');
    const committedBefore = before.body.hubs.find((x) => x.id === h.id).committedMealsToday;
    assert.ok(committedBefore > 0, 'the lot holds capacity while assigned');

    const collection = await call('/api/collections', {
      method: 'POST',
      body: { assignmentId: assignment.body.assignmentId, collectedKg: 5 },
    });
    assert.equal(collection.status, 201);

    const after = await call('/api/hubs');
    assert.equal(
      after.body.hubs.find((x) => x.id === h.id).committedMealsToday,
      0,
      'and releases it once the food moved',
    );

    const impact = await call('/api/impact');
    assert.equal(impact.status, 200);
    assert.equal(impact.body.totals.collections, 1);
    assert.equal(impact.body.totals.meals, 20);
    assert.equal(impact.body.totals.kg, 5, '5kg delivered is 5kg, not a tenth of it');
    // 20 meals at 250g is 5kg. If the weight and the meal count ever disagree
    // about the same handover, the page is contradicting itself and no other
    // number on it can be trusted either.
    assert.equal(
      impact.body.totals.kg,
      (impact.body.totals.meals * 250) / 1000,
      'weight and meal count must describe the same food',
    );
    assert.ok(impact.body.totals.co2eKg > 0);
    assert.match(impact.body.basis, /completed collections only/i);
  });

  test('a cancelled handover is reported as excluded, not silently dropped', async () => {
    // The whole point of excludedNotCollected is that it is a real count. If the
    // route filtered cancelled rows out before summarising, this would read zero
    // and the page would imply nothing was ever left out.
    const s = await makeSupplier();
    await makeHub();
    const a = await makeLot(s.id);
    const b = await makeLot(s.id, { quantityKg: 5, title: 'Cancelled curry' });

    const first = await call(`/api/surplus/${a.id}/assign`, { method: 'POST' });
    const second = await call(`/api/surplus/${b.id}/assign`, { method: 'POST' });

    await call('/api/collections', {
      method: 'POST',
      body: { assignmentId: first.body.assignmentId, collectedKg: 5 },
    });
    await call('/api/collections', {
      method: 'POST',
      body: { assignmentId: second.body.assignmentId, status: 'cancelled' },
    });

    const impact = await call('/api/impact');
    assert.equal(impact.body.totals.collections, 1, 'only the completed one counts');
    assert.equal(impact.body.excludedNotCollected, 1, 'and the cancellation is still reported');
  });

  test('logging the same handover twice is refused, which is the whole point', async () => {
    const s = await makeSupplier();
    await makeHub();
    const lot = await makeLot(s.id);
    const assignment = await call(`/api/surplus/${lot.id}/assign`, { method: 'POST' });

    await call('/api/collections', {
      method: 'POST',
      body: { assignmentId: assignment.body.assignmentId, collectedKg: 5 },
    });
    const second = await call('/api/collections', {
      method: 'POST',
      body: { assignmentId: assignment.body.assignmentId, collectedKg: 5 },
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'already_collected');

    const impact = await call('/api/impact');
    assert.equal(impact.body.totals.collections, 1, 'the meal was not counted twice');
  });

  test('a hub with no category restriction reports that it accepts everything', async () => {
    // Written straight to the row, because the API's own validation defaults
    // accepts to the full list. This is the shape the seed script creates, where
    // an empty column means "no restriction".
    //
    // Returning [] would let a client render a hub that accepts nothing, when it
    // accepts all of it. That is the more dangerous of the two mistakes, because
    // an empty list looks like a policy.
    await createHubRow(pool, {
      name: 'Open Kitchen',
      organisation: 'Open Trust',
      contactName: 'Ravi Kumar',
      phone: '98765000009',
      city: 'Hyderabad',
      lat: 17.3899,
      lon: 78.4983,
      dailyCapacityMeals: 200,
      opensAt: '06:00:00',
      closesAt: '23:00:00',
    });

    const r = await call('/api/hubs');
    const hub = r.body.hubs.find((h) => h.name === 'Open Kitchen');
    assert.ok(hub, 'the hub should be listed');
    assert.deepEqual(hub.accepts, ['prepared', 'bakery', 'produce', 'dairy', 'meat', 'other']);
  });

  test('a restricted hub reports only what it takes', async () => {
    await makeHub({ name: 'Dairy Only', accepts: ['dairy', 'bakery'] });
    const r = await call('/api/hubs');
    const hub = r.body.hubs.find((h) => h.name === 'Dairy Only');
    assert.deepEqual(hub.accepts, ['dairy', 'bakery']);
  });

  test('allocate places a batch and reports what did not fit', async () => {
    const s = await makeSupplier();
    await makeHub({ dailyCapacityMeals: 20 });
    for (let i = 0; i < 3; i += 1) {
      await makeLot(s.id, { quantityKg: 5, title: `lot ${i}` });
    }

    const r = await call('/api/allocate', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.placed.length, 1, 'one 20 meal lot fits in a 20 meal hub');
    assert.equal(r.body.unplaced.length, 2);
  });

  test('the list endpoint carries a safety verdict for every lot', async () => {
    // Without this, a lot the rules will refuse is drawn as "awaiting a hub",
    // which presents food that can never be routed as merely pending. The board
    // groups on this field, so it belongs on the list, not only the detail.
    const s = await makeSupplier();
    await makeHub({ dailyCapacityMeals: 9999 });
    const ok = await makeLot(s.id, { title: 'Safe curry' });
    const expired = await makeLot(s.id, { title: 'Old curry', safeUntil: at(-5) });
    const noExpiry = await makeLot(s.id, { title: 'Mystery curry', safeUntil: null });

    const r = await call('/api/surplus');
    const byId = new Map(r.body.surplus.map((x) => [x.id, x]));

    for (const lot of [ok, expired, noExpiry]) {
      assert.ok(byId.get(lot.id)?.safety, `no safety block for ${lot.title}`);
    }
    assert.equal(byId.get(ok.id).safety.safe, true);
    assert.equal(byId.get(expired.id).safety.safe, false);
    assert.equal(byId.get(expired.id).safety.reasons[0].reason, 'past_safe_use');
    assert.equal(byId.get(noExpiry.id).safety.safe, false);
    assert.equal(byId.get(noExpiry.id).safety.reasons[0].reason, 'no_expiry_recorded');
  });
});

describe('validation happens before the database', () => {
  test('a missing required field is a 400 naming the field', async () => {
    const r = await call('/api/suppliers', { method: 'POST', body: { name: 'No contact' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'contactName');
  });

  test('a bad phone number is refused', async () => {
    const r = await call('/api/suppliers', {
      method: 'POST',
      body: { name: 'X', contactName: 'Y', phone: '123' },
    });
    assert.equal(r.status, 400);
  });

  test('an unknown category is refused and the list is returned', async () => {
    const r = await call('/api/hubs', {
      method: 'POST',
      body: {
        name: 'Test Hub',
        organisation: 'Test Trust',
        contactName: 'Ravi Kumar',
        phone: '98765000001',
        accepts: ['unicorns'],
      },
    });
    assert.equal(r.status, 400);
    // The legal values come back, so a client can offer the right options rather
    // than showing the person a field that just says no.
    assert.ok(Array.isArray(r.body.allowed), r.text);
    assert.ok(r.body.allowed.includes('prepared'));
    assert.equal(r.body.field, 'accepts');
  });

  test('a hub that closes before it opens is refused', async () => {
    const r = await call('/api/hubs', {
      method: 'POST',
      body: {
        name: 'X', organisation: 'Y', contactName: 'Z', phone: '98765000002',
        opensAt: '21:00:00', closesAt: '09:00:00',
      },
    });
    assert.equal(r.status, 400);
  });

  test('a pickup window that closes before it opens is refused', async () => {
    const s = await makeSupplier();
    const r = await call('/api/surplus', {
      method: 'POST',
      body: {
        supplierId: s.id, title: 'Curry', quantityKg: 5, safeUntil: at(180),
        pickupWindow: { opensAt: at(150), closesAt: at(30) },
      },
    });
    assert.equal(r.status, 400);
  });

  test('a negative quantity is refused', async () => {
    const s = await makeSupplier();
    const r = await call('/api/surplus', {
      method: 'POST',
      body: { supplierId: s.id, title: 'Curry', quantityKg: -5, safeUntil: at(180) },
    });
    assert.equal(r.status, 400);
  });

  test('a lot for a supplier that does not exist is a 400 not a 500', async () => {
    const r = await call('/api/surplus', {
      method: 'POST',
      body: { supplierId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', title: 'Curry', quantityKg: 5, safeUntil: at(180) },
    });
    assert.equal(r.status, 400);
  });

  test('a duplicate supplier phone is a 409', async () => {
    await makeSupplier({ phone: '98765000111' });
    const r = await call('/api/suppliers', {
      method: 'POST',
      body: { name: 'Copy Cafe', contactName: 'Asha', phone: '98765000111' },
    });
    // A conflict, not a 400. The request was well formed, it just collides with
    // something already stored, and telling a supplier their name is invalid when
    // it is their phone number sends them looking in the wrong place.
    assert.equal(r.status, 409, r.text);
  });

  test('a completed collection must record a weight or a meal count', async () => {
    const r = await call('/api/collections', {
      method: 'POST',
      body: { assignmentId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', status: 'collected' },
    });
    assert.equal(r.status, 400);
  });

  test('malformed JSON is a 400 rather than a crash', async () => {
    const res = await fetch(`${base}/api/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
  });

  test('an oversized body is refused', async () => {
    const res = await fetch(`${base}/api/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(60_000), contactName: 'y', phone: '98765000999' }),
    });
    assert.ok([413, 400].includes(res.status), `expected 413 or 400, got ${res.status}`);
  });
});

describe('things that must not leak', () => {
  test('an unknown endpoint is a 404 problem document', async () => {
    const r = await call('/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.type, 'urn:foodforward:not_found');
  });

  test('no SQL or driver detail appears in any error', async () => {
    const probes = [
      ['/api/surpus/1/assign', 'POST'],
      ['/api/collections', 'POST'],
      ['/api/suppliers', 'POST'],
    ];
    for (const [path, method] of probes) {
      const r = await call(path, { method, body: method === 'POST' ? { junk: true } : undefined });
      const text = r.text.toLowerCase();
      for (const leak of ['select ', 'from surplus', 'mysql', 'er_', 'constraint', 'stack']) {
        assert.ok(!text.includes(leak), `${path} leaked "${leak}": ${r.text.slice(0, 120)}`);
      }
    }
  });

  test('security headers are set', async () => {
    const r = await call('/api/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('CORS refuses an origin that is not on the list', async () => {
    // Reflecting the caller alongside credentials is what lets any site make
    // authenticated requests here.
    const r = await call('/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.notEqual(r.headers.get('access-control-allow-origin'), 'https://evil.example');
  });
});
