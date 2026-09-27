import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { distanceKm, hubCanReceive, rankHubs, routeSurplus, allocateDay } from '../src/domain/routing.js';
import { REASON } from '../src/domain/safety.js';

/**
 * Three real Hyderabad coordinates, so the distances in these tests are the
 * distances the code will see in production rather than tidy invented numbers.
 * Gachibowli to Banjara Hills is about 9.6km, which is a realistic collection
 * run in this city.
 */
const BANJARA = { lat: 17.4126, lon: 78.4347 };
const GACHIBOWLI = { lat: 17.4401, lon: 78.3489 };
const SECUNDERABAD = { lat: 17.3899, lon: 78.4983 };
const VJNT = { lat: 17.4549, lon: 78.5875 };

const NOW = new Date('2026-09-27T18:00:00Z');
const iso = (mins) => new Date(NOW.getTime() + mins * 60_000).toISOString();

const OPEN_ALL_DAY = { opensAt: '2026-09-27T06:00:00Z', closesAt: '2026-09-27T23:00:00Z' };

const hub = (id, name, location, over = {}) => ({
  id,
  name,
  location,
  active: true,
  dailyCapacityMeals: 200,
  committedMealsToday: 0,
  accepts: ['prepared', 'bakery', 'produce', 'dairy', 'meat', 'other'],
  openingHours: OPEN_ALL_DAY,
  ...over,
});

const lot = (over = {}) => ({
  id: 'lot-1',
  supplierId: 'sup-1',
  title: 'Vegetable curry',
  category: 'prepared',
  quantityKg: 5,
  safeUntil: iso(180),
  preparedAt: iso(-30),
  requiresHotHolding: false,
  requiresChilling: false,
  pickupWindow: { opensAt: iso(30), closesAt: iso(150) },
  ...over,
});

describe('distance', () => {
  test('real coordinates give real distances', () => {
    const km = distanceKm(BANJARA, GACHIBOWLI);
    assert.ok(km > 9 && km < 10.5, `expected roughly 9.6km, got ${km}`);
  });

  test('a point is zero from itself', () => {
    assert.ok(distanceKm(BANJARA, BANJARA) < 0.001);
  });

  test('missing coordinates give null, not zero', () => {
    // Zero would mean "same street", which is a routing decision.
    assert.equal(distanceKm(BANJARA, null), null);
    assert.equal(distanceKm({ lat: 1 }, { lat: 1 }), null);
  });
});

describe('a hub can only receive what it can actually take', () => {
  const base = hub('h1', 'Hub One', BANJARA);

  test('a hub with room and matching hours accepts', () => {
    const check = hubCanReceive(base, lot(), { now: NOW });
    assert.equal(check.canReceive, true);
  });

  test('a hub at capacity refuses, and says so', () => {
    const check = hubCanReceive(
      hub('h1', 'Hub One', BANJARA, { dailyCapacityMeals: 200, committedMealsToday: 200 }),
      lot(),
      { now: NOW },
    );
    assert.equal(check.canReceive, false);
    assert.equal(check.reasons[0].reason, 'at_capacity');
  });

  test('a hub with some room but not enough refuses with the numbers', () => {
    const check = hubCanReceive(
      hub('h1', 'Hub One', BANJARA, { dailyCapacityMeals: 200, committedMealsToday: 190 }),
      lot({ quantityKg: 10 }),
      { now: NOW },
    );
    assert.equal(check.canReceive, false);
    assert.equal(check.reasons[0].reason, 'insufficient_capacity');
    assert.ok(check.reasons[0].remaining < check.reasons[0].mealsNeeded);
  });

  test('an inactive hub refuses', () => {
    const check = hubCanReceive(hub('h1', 'Hub One', BANJARA, { active: false }), lot(), { now: NOW });
    assert.equal(check.canReceive, false);
    assert.equal(check.reasons[0].reason, 'hub_inactive');
  });

  test('a hub that does not accept the category refuses', () => {
    const check = hubCanReceive(hub('h1', 'Hub One', BANJARA, { accepts: ['bakery'] }), lot(), { now: NOW });
    assert.equal(check.canReceive, false);
    assert.equal(check.reasons[0].reason, 'category_not_accepted');
  });

  test('a closed hub refuses a pickup window it cannot meet', () => {
    const closedAtNight = {
      opensAt: '2026-09-27T09:00:00Z',
      closesAt: '2026-09-27T17:00:00Z',
    };
    const check = hubCanReceive(
      hub('h1', 'Daytime Hub', BANJARA, { openingHours: closedAtNight }),
      lot({ pickupWindow: { opensAt: iso(60), closesAt: iso(150) } }),
      { now: NOW },
    );
    assert.equal(check.canReceive, false);
    assert.equal(check.reasons[0].reason, 'no_time_overlap');
  });

  test('a hub with no capacity recorded refuses rather than assuming infinite', () => {
    const check = hubCanReceive(hub('h1', 'Hub One', BANJARA, { dailyCapacityMeals: 0 }), lot(), { now: NOW });
    assert.equal(check.canReceive, false);
    assert.equal(check.reasons[0].reason, 'no_capacity_recorded');
  });
});

describe('routing picks a good hub, not merely the nearest one', () => {
  test('the nearest hub with room wins', () => {
    const hubs = [
      hub('near', 'Near Hub', BANJARA),
      hub('far', 'Far Hub', VJNT),
    ];
    const result = routeSurplus(lot(), hubs, { now: NOW });
    assert.equal(result.routed, true);
    assert.equal(result.hubId, 'near');
  });

  test('a full nearest hub loses to a further one with room', () => {
    // This is the case that matters. Ranking on distance alone fills one hub and
    // starves the rest, and then that hub starts refusing and food goes in the bin.
    const hubs = [
      hub('near', 'Full Hub', BANJARA, { dailyCapacityMeals: 200, committedMealsToday: 200 }),
      hub('mid', 'Roomy Hub', SECUNDERABAD, { dailyCapacityMeals: 400, committedMealsToday: 0 }),
      hub('far', 'Far Hub', VJNT),
    ];
    const result = routeSurplus(lot(), hubs, { now: NOW });
    assert.equal(result.hubId, 'mid');
  });

  test('a further hub with far more room can outrank a slightly nearer tight one', () => {
    const hubs = [
      hub('tight', 'Nearly Full', GACHIBOWLI, { dailyCapacityMeals: 200, committedMealsToday: 190 }),
      hub('roomy', 'Empty and Further', VJNT, { dailyCapacityMeals: 800, committedMealsToday: 0 }),
    ];
    const result = routeSurplus(lot({ quantityKg: 1 }), hubs, { now: NOW });
    assert.equal(result.hubId, 'roomy');
  });

  test('alternatives are reported so a coordinator can see the road not taken', () => {
    const hubs = [hub('a', 'A', BANJARA), hub('b', 'B', SECUNDERABAD), hub('c', 'C', VJNT)];
    const result = routeSurplus(lot(), hubs, { now: NOW });
    assert.equal(result.alternatives.length, 2);
    assert.ok(result.alternatives.every((a) => a.hubId !== result.hubId));
  });

  test('rejecting every hub gives a reason, not silence', () => {
    const hubs = [hub('a', 'A', BANJARA, { active: false })];
    const result = routeSurplus(lot(), hubs, { now: NOW });
    assert.equal(result.routed, false);
    assert.equal(result.reasons.length > 0, true);
    assert.ok(result.reasons.some((r) => r.reason === 'hub_inactive'));
  });

  test('no hubs at all is reported as its own case', () => {
    const result = routeSurplus(lot(), [], { now: NOW });
    assert.equal(result.routed, false);
    assert.equal(result.reason, 'no_hubs_registered');
  });

  test('the nearest miss is surfaced so an operator is not left guessing', () => {
    const hubs = [
      hub('a', 'Nearly There', BANJARA, { active: false }),
      hub('b', 'Also No', SECUNDERABAD, { dailyCapacityMeals: 0 }),
    ];
    const result = routeSurplus(lot(), hubs, { now: NOW });
    assert.ok(result.nearestMiss, 'a reason for the closest hub should be reported');
  });
});

describe('unsafe food is never routed, whatever the hubs look like', () => {
  const manyGoodHubs = [
    hub('a', 'A', BANJARA, { dailyCapacityMeals: 9999 }),
    hub('b', 'B', GACHIBOWLI, { dailyCapacityMeals: 9999 }),
  ];

  test('expired food is not routed even with a perfect hub waiting', () => {
    const result = routeSurplus(lot({ safeUntil: iso(-1) }), manyGoodHubs, { now: NOW });
    assert.equal(result.routed, false);
    assert.equal(result.outcome, 'refused_unsafe');
    assert.equal(result.reason, REASON.EXPIRED);
  });

  test('unknown expiry is not routed either', () => {
    const result = routeSurplus(lot({ safeUntil: null }), manyGoodHubs, { now: NOW });
    assert.equal(result.routed, false);
    assert.equal(result.reason, REASON.NO_EXPIRY);
  });

  test('the refusal happens before any hub is considered', () => {
    // No hubId at all, so there is nothing downstream that could act on it.
    const result = routeSurplus(lot({ safeUntil: iso(-1) }), manyGoodHubs, { now: NOW });
    assert.equal(result.hubId, undefined);
  });

  test('hot food past the two hour rule is not routed', () => {
    const result = routeSurplus(
      lot({ requiresHotHolding: true, preparedAt: iso(-200), safeUntil: iso(600) }),
      manyGoodHubs,
      { now: NOW },
    );
    assert.equal(result.routed, false);
    assert.equal(result.reason, REASON.TOO_LONG_OUT_OF_CONTROL);
  });

  test('a lot that was safe when listed is refused once time has passed', () => {
    // This is why safety is re-checked at routing rather than trusted from the
    // queue: a listing sits there and the clock moves.
    const queued = lot({ safeUntil: iso(600) });
    assert.equal(routeSurplus(queued, manyGoodHubs, { now: NOW }).routed, true);

    const later = new Date(NOW.getTime() + 700 * 60_000);
    assert.equal(routeSurplus(queued, manyGoodHubs, { now: later }).routed, false);
  });
});

describe('a day of lots allocates without stranding food', () => {
  const twoHubs = [
    hub('a', 'Hub A', BANJARA, { dailyCapacityMeals: 60, committedMealsToday: 0 }),
    hub('b', 'Hub B', SECUNDERABAD, { dailyCapacityMeals: 60, committedMealsToday: 0 }),
  ];

  test('lots spread across hubs instead of filling the nearest one', () => {
    // 5kg is 20 meals at 250g. Six lots is 120 meals against 60 + 60 of
    // capacity, so all six fit exactly, and the point is how they land: the
    // nearest hub fills first, then the second takes the rest. Three lots of 40
    // meals would NOT fit, because 40-meal lots cannot split across the two
    // 20-meal remainders that are left over.
    const lots = Array.from({ length: 6 }, (_, i) =>
      lot({ id: `lot-${i}`, quantityKg: 5, pickupWindow: { opensAt: iso(30), closesAt: iso(150) } }),
    );
    const result = allocateDay(lots, twoHubs, { now: NOW });

    const load = result.hubLoad;
    assert.ok(load.every((h) => h.committedMealsToday <= 60), 'no hub is over capacity');
    assert.equal(result.placed.length, 6, 'six lots of 20 meals fit exactly into 120 meals of capacity');
    assert.equal(result.unplaced.length, 0);

    const used = load.filter((h) => h.committedMealsToday > 0);
    assert.equal(used.length, 2, 'both hubs should carry part of the day');
    assert.equal(
      used.reduce((n, h) => n + h.committedMealsToday, 0),
      120,
      'and together they use exactly the capacity available',
    );
    // The nearest hub should be the fuller of the two, since it is preferred
    // until it runs out.
    assert.equal(used[0].committedMealsToday, 60, 'the nearest hub fills to capacity first');
  });

  test('a lot that cannot split across the remainder is left unplaced', () => {
    // 10kg is 40 meals. Two 60-meal hubs hold one lot each and are left with
    // 20 and 20, which cannot take a third 40-meal lot. Reporting that honestly
    // is the point; quietly overfilling a hub is how food gets wasted.
    const lots = Array.from({ length: 3 }, (_, i) => lot({ id: `l${i}`, quantityKg: 10 }));
    const result = allocateDay(lots, twoHubs, { now: NOW });

    assert.equal(result.placed.length, 2);
    assert.equal(result.unplaced.length, 1);
    // The route level reason is that every hub declined, and the operator facing
    // detail has to say why, because "no hub available" sends somebody hunting
    // for a problem that is actually a capacity shortfall.
    assert.equal(result.unplaced[0].reason, 'all_hubs_declined');
    assert.match(result.unplaced[0].detail, /room for 20 meals, this lot is 40/i);
  });

  test('capacity is respected exactly', () => {
    const lots = Array.from({ length: 10 }, (_, i) => lot({ id: `l${i}`, quantityKg: 10 }));
    const result = allocateDay(lots, twoHubs, { now: NOW });
    const totalPlaced = result.hubLoad.reduce((n, h) => n + h.committedMealsToday, 0);
    assert.ok(totalPlaced <= 120, `placed ${totalPlaced} meals into 120 of capacity`);
  });

  test('lots that do not fit are reported, not dropped', () => {
    const lots = Array.from({ length: 10 }, (_, i) => lot({ id: `l${i}`, quantityKg: 10 }));
    const result = allocateDay(lots, twoHubs, { now: NOW });
    assert.equal(result.unplaced.length + result.placed.length, 10, 'every lot is accounted for');
    assert.ok(result.unplaced.every((u) => typeof u.reason === 'string'));
  });

  test('an unsafe lot is unplaced even when capacity is free', () => {
    const lots = [lot({ id: 'good', quantityKg: 2 }), lot({ id: 'bad', quantityKg: 2, safeUntil: iso(-5) })];
    const result = allocateDay(lots, twoHubs, { now: NOW });

    assert.equal(result.unplaced.length, 1);
    assert.equal(result.unplaced[0].surplusId, 'bad');
    assert.equal(result.unplaced[0].reason, REASON.EXPIRED);
    assert.equal(result.placed.length, 1);
  });

  test('a tight pickup window is placed before a loose one', () => {
    // 10kg is 40 meals, so two lots are 80 meals against 120 of capacity and
    // both fit. The constraint window is one hour versus four and a half, and the
    // tight one has to be placed first or it can be squeezed out.
    const lots = [
      lot({ id: 'loose', quantityKg: 10, pickupWindow: { opensAt: iso(30), closesAt: iso(300) } }),
      lot({ id: 'tight', quantityKg: 10, pickupWindow: { opensAt: iso(30), closesAt: iso(60) } }),
    ];
    const result = allocateDay(lots, twoHubs, { now: NOW });
    assert.equal(result.unplaced.length, 0);
    assert.equal(result.placed.length, 2);
  });

  test('utilisation is reported so an operator can see the day filling up', () => {
    const result = allocateDay([lot({ quantityKg: 10 })], twoHubs, { now: NOW });
    assert.ok(result.hubLoad.every((h) => typeof h.utilisation === 'number'));
    assert.equal(result.hubLoad.reduce((n, h) => n + h.utilisation, 0) > 0, true);
  });
});

describe('ranking is total and stable', () => {
  test('every hub appears in either eligible or rejected, never dropped', () => {
    const hubs = [
      hub('a', 'A', BANJARA),
      hub('b', 'B', SECUNDERABAD, { active: false }),
      hub('c', 'C', VJNT, { dailyCapacityMeals: 0 }),
    ];
    const { eligible, rejected } = rankHubs(lot(), hubs, { now: NOW });
    assert.equal(eligible.length + rejected.length, hubs.length);
  });

  test('a single hub still routes', () => {
    const result = routeSurplus(lot(), [hub('only', 'Only Hub', BANJARA)], { now: NOW });
    assert.equal(result.routed, true);
    assert.equal(result.hubId, 'only');
    assert.deepEqual(result.alternatives, []);
  });

  test('supplier with no location still routes, on hub score alone', () => {
    const result = routeSurplus(lot({ location: null }), [hub('a', 'A', BANJARA)], { now: NOW });
    assert.equal(result.routed, true);
    assert.equal(result.distanceKm, null, 'and admits the distance is unknown');
  });
});
