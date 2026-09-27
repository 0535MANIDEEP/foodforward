import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { impactForCollection, summariseImpact, COLLECTION_STATUS } from '../src/domain/impact.js';

const AT = new Date('2026-09-27T19:00:00Z');
const iso = (mins) => new Date(AT.getTime() + mins * 60_000).toISOString();

const surplus = (over = {}) => ({
  id: 's1',
  supplierId: 'sup-1',
  category: 'prepared',
  quantityKg: 10,
  ...over,
});

const hub = { id: 'h1', name: 'Community Kitchen' };

const collected = (over = {}) => ({
  id: 'c1',
  status: COLLECTION_STATUS.COLLECTED,
  collectedKg: 10,
  collectedAt: iso(0),
  ...over,
});

describe('only food that was actually collected counts', () => {
  test('a completed collection produces an impact record', () => {
    const impact = impactForCollection({ collection: collected(), surplus: surplus(), hub });
    assert.equal(impact.counted, true);
    assert.equal(impact.meals, 40, '10kg at 250g is 40 meals');
    assert.equal(impact.kg, 10);
    assert.ok(impact.co2eKg > 0);
  });

  test('a cancelled collection counts for nothing', () => {
    // Not an error. It has an impact of exactly zero, said explicitly, so a
    // dashboard sum cannot quietly disagree with itself.
    for (const status of [COLLECTION_STATUS.CANCELLED, COLLECTION_STATUS.SCHEDULED, COLLECTION_STATUS.MISSED]) {
      const impact = impactForCollection({ collection: collected({ status }), surplus: surplus(), hub });
      assert.equal(impact.counted, false, status);
      assert.equal(impact.meals, 0, status);
      assert.equal(impact.kg, 0, status);
      assert.equal(impact.co2eKg, 0, status);
    }
  });

  test('listed surplus that was never collected feeds nobody and is not counted', () => {
    // The single most important property of an impact page. Counting listings is
    // how a food rescue project ends up claiming meals that were eaten by
    // whoever logged them.
    const records = [
      impactForCollection({ collection: collected(), surplus: surplus(), hub }),
      impactForCollection({ collection: collected({ id: 'c2', status: COLLECTION_STATUS.CANCELLED }), surplus: surplus(), hub }),
    ];
    const summary = summariseImpact(records);
    assert.equal(summary.totals.collections, 1);
    assert.equal(summary.excludedNotCollected, 1);
  });

  test('the collected weight wins over the listed weight', () => {
    // What actually left the kitchen is what fed somebody, and the two
    // legitimately differ.
    const impact = impactForCollection({
      collection: collected({ collectedKg: 7.5 }),
      surplus: surplus({ quantityKg: 10 }),
      hub,
    });
    assert.equal(impact.kg, 7.5);
    assert.equal(impact.meals, 30, '7.5kg at 250g is 30 meals');
  });

  test('an explicit meal count from the hub is trusted over our estimate', () => {
    const impact = impactForCollection({
      collection: collected({ collectedKg: 10, collectedMeals: 55 }),
      surplus: surplus(),
      hub,
    });
    assert.equal(impact.meals, 55, 'the hub counted, so we use their number');
  });

  test('the portion size used is recorded, so the figure can be recomputed', () => {
    const impact = impactForCollection({ collection: collected(), surplus: surplus(), hub, gramsPerMeal: 200 });
    assert.equal(impact.meals, 50, '10kg at 200g is 50 meals');
    assert.equal(impact.gramsPerMeal, 200);
  });
});

describe('the summary is rebuilt from rows, never from a stored total', () => {
  const records = [
    impactForCollection({
      collection: collected({ id: 'c1', collectedKg: 10, collectedAt: iso(0) }),
      surplus: surplus({ category: 'prepared' }),
      hub,
    }),
    impactForCollection({
      collection: collected({ id: 'c2', collectedKg: 5, collectedAt: iso(60) }),
      surplus: surplus({ category: 'bakery' }),
      hub: { id: 'h2', name: 'Shelter Two' },
    }),
    impactForCollection({
      collection: collected({ id: 'c3', collectedKg: 2, collectedAt: iso(120) }),
      surplus: surplus({ category: 'prepared' }),
      hub,
    }),
  ];

  test('totals add up', () => {
    const summary = summariseImpact(records);
    assert.equal(summary.totals.collections, 3);
    assert.equal(summary.totals.kg, 17);
    assert.equal(summary.totals.meals, 40 + 20 + 8);
  });

  test('it groups by hub, most meals first', () => {
    const summary = summariseImpact(records);
    assert.equal(summary.byHub[0].hubName, 'Community Kitchen');
    assert.equal(summary.byHub[0].meals, 48);
    assert.equal(summary.byHub[1].hubName, 'Shelter Two');
  });

  test('it groups by category', () => {
    const summary = summariseImpact(records);
    assert.equal(summary.byCategory.length, 2);
    assert.equal(summary.byCategory[0].category, 'prepared');
    assert.equal(summary.byCategory[0].meals, 48);
  });

  test('a date range filters, and the range is reported back', () => {
    const summary = summariseImpact(records, { from: iso(30), to: iso(180) });
    assert.equal(summary.totals.collections, 2, 'the first collection is outside the range');
    assert.equal(summary.from, iso(30));
    assert.equal(summary.to, iso(180));
  });

  test('an empty set reports zero rather than failing', () => {
    const summary = summariseImpact([]);
    assert.deepEqual(summary.totals, { collections: 0, meals: 0, kg: 0, co2eKg: 0 });
    assert.deepEqual(summary.byHub, []);
  });

  test('the basis is stated on the page, not just in the code', () => {
    // A reader deserves to know the denominator, and "meals" without a basis is
    // how a number gets quoted out of context.
    assert.match(summariseImpact(records).basis, /completed collections only/i);
  });

  test('malformed records are skipped rather than producing NaN totals', () => {
    const summary = summariseImpact([...records, null, {}, { counted: true, at: 'nonsense', meals: 5 }]);
    assert.equal(summary.totals.collections, 3, 'only the real ones counted');
    assert.ok(Number.isFinite(summary.totals.meals));
  });
});
