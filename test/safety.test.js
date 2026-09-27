import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessSurplus,
  assertSurplusSafe,
  UnsafeFoodError,
  kgToMeals,
  mealsToKg,
  co2eAvoidedKg,
  REASON,
  MAX_OUT_OF_CONTROL_MINUTES,
} from '../src/domain/safety.js';

/**
 * The safety rules are refusals, not warnings, so they are tested as refusals.
 * Every test here asserts that something is NOT allowed to happen.
 */

const NOW = new Date('2026-09-27T19:00:00Z');
const iso = (mins) => new Date(NOW.getTime() + mins * 60_000).toISOString();

const base = {
  id: 's1',
  supplierId: 'sup1',
  title: 'Vegetable curry',
  category: 'prepared',
  quantityKg: 5,
  safeUntil: iso(120),
  preparedAt: iso(-30),
  requiresHotHolding: false,
  requiresChilling: false,
  heldAtC: null,
  pickupWindow: { opensAt: iso(60), closesAt: iso(180) },
};

describe('unknown expiry is refused, not guessed', () => {
  test('a listing with no safe-until time cannot be routed', () => {
    // The single most important rule. A supplier who does not say when food goes
    // off has not given us enough to send it to a family.
    const verdict = assessSurplus({ ...base, safeUntil: null }, NOW);
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reasons[0].reason, REASON.NO_EXPIRY);
  });

  test('an unparseable expiry is treated as unknown, not as valid', () => {
    for (const bad of ['', 'not a date', undefined, '   ']) {
      const verdict = assessSurplus({ ...base, safeUntil: bad }, NOW);
      assert.equal(verdict.safe, false, `safeUntil=${JSON.stringify(bad)} should be refused`);
    }
  });

  test('a null expiry is not silently read as the epoch', () => {
    // new Date(null) is 1970, so a naive parser treats "no date" as "expired in
    // 1970" and every listing looks unsafe for a different reason. The reason
    // code has to be the honest one.
    const verdict = assessSurplus({ ...base, safeUntil: null }, NOW);
    assert.equal(verdict.reasons[0].reason, REASON.NO_EXPIRY);
    assert.equal(verdict.reasons.some((r) => r.reason === REASON.EXPIRED), false);
  });

  test('the throwing form throws for unknown expiry', () => {
    assert.throws(() => assertSurplusSafe({ ...base, safeUntil: null }, NOW), UnsafeFoodError);
  });
});

describe('expired food is refused', () => {
  test('food past its safe-until time cannot be routed', () => {
    const verdict = assessSurplus({ ...base, safeUntil: iso(-1) }, NOW);
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reasons[0].reason, REASON.EXPIRED);
  });

  test('the boundary is exclusive: safe until the exact instant, not after', () => {
    const exactlyNow = assessSurplus({ ...base, safeUntil: NOW.toISOString() }, NOW);
    assert.equal(exactlyNow.safe, false, 'at the instant it is no longer safe');

    const oneMinuteAhead = assessSurplus({ ...base, safeUntil: iso(1) }, NOW);
    assert.equal(oneMinuteAhead.safe, true);
  });

  test('the refusal carries the time it went off, so a supplier can be told', () => {
    const verdict = assessSurplus({ ...base, safeUntil: iso(-30) }, NOW);
    assert.equal(verdict.reasons[0].safeUntil, iso(-30));
  });
});

describe('the two hour rule', () => {
  test('hot food inside the window is fine', () => {
    const verdict = assessSurplus({ ...base, requiresHotHolding: true, preparedAt: iso(-30) }, NOW);
    assert.equal(verdict.safe, true);
  });

  test('hot food past two hours out of control is refused', () => {
    const verdict = assessSurplus(
      { ...base, requiresHotHolding: true, preparedAt: iso(-(MAX_OUT_OF_CONTROL_MINUTES + 1)) },
      NOW,
    );
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reasons[0].reason, REASON.TOO_LONG_OUT_OF_CONTROL);
  });

  test('hot food at exactly two hours is still allowed', () => {
    const verdict = assessSurplus(
      { ...base, requiresHotHolding: true, preparedAt: iso(-MAX_OUT_OF_CONTROL_MINUTES) },
      NOW,
    );
    assert.equal(verdict.safe, true);
  });

  test('hot food with no prepared-at time cannot be checked, so it is refused', () => {
    const verdict = assessSurplus({ ...base, requiresHotHolding: true, preparedAt: null }, NOW);
    assert.equal(verdict.safe, false);
  });

  test('the two hour rule applies even when the date is still valid', () => {
    // A generous expiry does not buy extra time at room temperature. This is the
    // case where a system that only checked dates would happily send food that
    // has been sitting out since this morning.
    const verdict = assessSurplus(
      { ...base, requiresHotHolding: true, preparedAt: iso(-200), safeUntil: iso(600) },
      NOW,
    );
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reasons.some((r) => r.reason === REASON.TOO_LONG_OUT_OF_CONTROL), true);
  });
});

describe('chilled food', () => {
  test('chilled food held warm is refused', () => {
    const verdict = assessSurplus({ ...base, requiresChilling: true, heldAtC: 22 }, NOW);
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reasons[0].reason, REASON.TOO_COLD_TO_SERVE);
  });

  test('chilled food properly cold is fine', () => {
    assert.equal(assessSurplus({ ...base, requiresChilling: true, heldAtC: 4 }, NOW).safe, true);
  });

  test('an unrecorded holding temperature is not treated as a failure', () => {
    // We cannot know the temperature, so we cannot refuse on it. The date rules
    // still apply. Refusing on a field nobody filled in would make every listing
    // unusable, which is a different and equally unhelpful failure.
    const verdict = assessSurplus({ ...base, requiresChilling: true, heldAtC: null }, NOW);
    assert.equal(verdict.safe, true);
  });
});

describe('a sane listing is allowed', () => {
  test('a well formed listing passes', () => {
    const verdict = assessSurplus(base, NOW);
    assert.equal(verdict.safe, true);
    assert.deepEqual(verdict.reasons, []);
  });

  test('a pickup window opening before the food was made is refused', () => {
    const verdict = assessSurplus(
      { ...base, preparedAt: iso(30), pickupWindow: { opensAt: iso(10), closesAt: iso(180) } },
      NOW,
    );
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reasons[0].reason, REASON.NOT_YET_READY);
  });

  test('malformed input is refused rather than throwing', () => {
    for (const bad of [null, undefined, {}, 'nonsense', 42]) {
      const verdict = assessSurplus(bad, NOW);
      assert.equal(verdict.safe, false, String(bad));
    }
  });
});

describe('unit conversion states its assumption', () => {
  test('kg to meals uses the supplied portion size', () => {
    assert.equal(kgToMeals(1, 250), 4);
    assert.equal(kgToMeals(1, 500), 2);
    assert.equal(kgToMeals(0.5, 250), 2);
  });

  test('it rounds down, because a partial meal is not a meal', () => {
    assert.equal(kgToMeals(0.3, 250), 1);
    assert.equal(kgToMeals(0.2, 250), 0);
  });

  test('a nonsense portion size is refused rather than producing Infinity', () => {
    assert.throws(() => kgToMeals(1, 0), RangeError);
    assert.throws(() => kgToMeals(1, -5), RangeError);
    assert.throws(() => kgToMeals(-1, 250), RangeError);
  });

  test('kg and meals round trip', () => {
    assert.equal(mealsToKg(kgToMeals(10, 250), 250), 10);
  });
});

describe('carbon figures use a per category factor', () => {
  test('meat scores far higher than produce, which is the point', () => {
    assert.ok(co2eAvoidedKg('meat', 1) > co2eAvoidedKg('produce', 1) * 5);
  });

  test('an unknown category falls back rather than throwing', () => {
    assert.equal(co2eAvoidedKg('unheard-of', 1), co2eAvoidedKg('other', 1));
  });
});
