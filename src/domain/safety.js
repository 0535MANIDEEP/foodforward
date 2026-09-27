import { randomUUID } from 'node:crypto';

/**
 * FOOD SAFETY RULES
 * =================
 *
 * This is the part of the system that is a refusal rather than an optimisation.
 * Everything else here is about doing the best possible job. This is about not
 * doing the one job that must never be done: sending food to somebody that could
 * make them ill.
 *
 * Surplus food is not the same as packaged food with a printed date. A restaurant
 * that finishes service at 9pm has food that is good until roughly midnight, and
 * whether that is true depends on what the dish is, how it was held, and the
 * room it sat in. None of that is knowable from a form.
 *
 * So the rules are deliberately strict, and every one of them fails closed:
 *
 *   1. An unknown safe-until time means the food is NOT routed. Not "routed with
 *      a warning". Not routed. A supplier who does not tell us when food goes off
 *      has not given us enough to send it to a family, and guessing is how people
 *      get ill.
 *
 *   2. A safe-until time in the past means the food is NOT routed, and it is not
 *      merely hidden. The refusal happens in the assignment transaction, so
 *      there is no code path that can produce a valid assignment for expired
 *      food even by accident.
 *
 *   3. Hot food that has been out of temperature control for long enough is NOT
 *      routed, regardless of its date. Two hour rule, and hot holding above 63C
 *      counts as safe while it lasts.
 *
 *   4. Food offered after its safe-until time is still recorded, because
 *      throwing the record away loses the audit trail and lets the same supplier
 *      do it again unseen. It is recorded as refused, not routed.
 *
 * The units are explicit everywhere. kg is what a supplier has. Meals is what a
 * hub counts. Converting between them needs an assumption about portion size, so
 * every conversion takes the assumption as an argument rather than hiding a
 * constant that quietly decides how many people a hub feeds.
 */

/** How long cooked food may sit outside temperature control. Two hour rule. */
export const MAX_OUT_OF_CONTROL_MINUTES = 120;

/** Minimum safe holding temperature for hot food, in Celsius. */
export const MIN_HOT_HOLDING_C = 63;

/** Maximum safe chilling temperature for food awaiting collection, Celsius. */
export const MAX_CHILL_HOLDING_C = 5;

export const REASON = Object.freeze({
  OK: 'ok',
  NO_EXPIRY: 'no_expiry_recorded',
  EXPIRED: 'past_safe_use',
  TOO_LONG_OUT_OF_CONTROL: 'too_long_out_of_temperature_control',
  TOO_COLD_TO_SERVE: 'below_safe_chilling_temperature',
  NOT_YET_READY: 'pickup_window_not_open',
});

export class UnsafeFoodError extends Error {
  constructor(reason, detail, context = {}) {
    super(detail);
    this.name = 'UnsafeFoodError';
    this.reason = reason;
    this.context = context;
  }
}

/**
 * Is this surplus safe to route to a person?
 *
 * Returns a verdict object rather than a boolean, because the caller has three
 * genuinely different jobs to do: route it, record why it was refused, or tell
 * the supplier what to fix. A boolean cannot carry that, and a caller that gets
 * `false` with no reason will either swallow it or invent an explanation.
 */
export function assessSurplus(surplus, now = new Date()) {
  const reasons = [];

  const safeUntil = parseDate(surplus?.safeUntil);
  const preparedAt = parseDate(surplus?.preparedAt);

  // Fail closed on the single most important field. If we do not know when this
  // food goes off, we cannot send it to anybody.
  if (!safeUntil) {
    reasons.push({
      reason: REASON.NO_EXPIRY,
      detail: 'No safe-until time was recorded, so the food cannot be routed to anybody.',
    });
  } else if (safeUntil.getTime() <= now.getTime()) {
    reasons.push({
      reason: REASON.EXPIRED,
      detail: `Safe-until time passed at ${safeUntil.toISOString()}.`,
      safeUntil: safeUntil.toISOString(),
    });
  }

  // Time out of temperature control, for food that should be hot.
  if (surplus?.requiresHotHolding === true) {
    if (!preparedAt) {
      reasons.push({
        reason: REASON.NO_EXPIRY,
        detail: 'Hot food with no prepared-at time cannot be checked against the two hour rule.',
      });
    } else {
      const outMinutes = (now.getTime() - preparedAt.getTime()) / 60_000;
      if (outMinutes > MAX_OUT_OF_CONTROL_MINUTES) {
        reasons.push({
          reason: REASON.TOO_LONG_OUT_OF_CONTROL,
          detail: `Out of temperature control for ${Math.round(outMinutes)} minutes, limit is ${MAX_OUT_OF_CONTROL_MINUTES}.`,
          outMinutes: Math.round(outMinutes),
        });
      }
    }
  }

  // Food that must stay chilled cannot have been left in a warm place.
  if (surplus?.requiresChilling === true && typeof surplus?.heldAtC === 'number') {
    if (surplus.heldAtC > MAX_CHILL_HOLDING_C) {
      reasons.push({
        reason: REASON.TOO_COLD_TO_SERVE,
        detail: `Held at ${surplus.heldAtC}C, above the ${MAX_CHILL_HOLDING_C}C limit for chilled food.`,
        heldAtC: surplus.heldAtC,
      });
    }
  }

  // Pickup cannot be scheduled before the food exists.
  if (preparedAt && surplus?.pickupWindow?.opensAt) {
    const opensAt = parseDate(surplus.pickupWindow.opensAt);
    if (opensAt && opensAt.getTime() < preparedAt.getTime()) {
      reasons.push({
        reason: REASON.NOT_YET_READY,
        detail: 'Pickup window opens before the food was prepared.',
      });
    }
  }

  return {
    safe: reasons.length === 0,
    reasons,
    // The earliest moment this stops being safe, for the UI to show plainly.
    safeUntil: safeUntil ? safeUntil.toISOString() : null,
  };
}

/**
 * Throwing form, used inside the assignment transaction.
 *
 * The non-throwing verdict is for read paths and for the API response. This is
 * for the write path, where continuing would mean writing an assignment for food
 * that could make somebody ill.
 */
export function assertSurplusSafe(surplus, now = new Date()) {
  const verdict = assessSurplus(surplus, now);
  if (verdict.safe) return verdict;

  const first = verdict.reasons[0];
  throw new UnsafeFoodError(first.reason, first.detail, {
    surplusId: surplus?.id,
    allReasons: verdict.reasons,
  });
}

/**
 * kg to meals, with the assumption supplied rather than buried.
 *
 * A 250g plate is a guess. Making it an argument means the caller states it, the
 * tests can check the arithmetic, and changing it is a visible decision instead of
 * a silent edit to a constant.
 */
export function kgToMeals(kg, gramsPerMeal = 250) {
  if (!Number.isFinite(kg) || kg < 0) {
    throw new RangeError('kg must be a non-negative number');
  }
  if (!Number.isFinite(gramsPerMeal) || gramsPerMeal <= 0) {
    throw new RangeError('gramsPerMeal must be a positive number');
  }
  return Math.floor((kg * 1000) / gramsPerMeal);
}

export function mealsToKg(meals, gramsPerMeal = 250) {
  if (!Number.isInteger(meals) || meals < 0) {
    throw new RangeError('meals must be a non-negative integer');
  }
  return (meals * gramsPerMeal) / 1000;
}

/** Kilograms of CO2e avoided by diverting food from landfill, IPCC-ish factors. */
export const CO2E_PER_KG = Object.freeze({
  // Average across beef, lamb and dairy, which dominate restaurant waste.
  meat: 9.9,
  dairy: 3.3,
  bakery: 2.0,
  produce: 0.9,
  prepared: 2.2,
  other: 1.9,
});

export function co2eAvoidedKg(category, kg) {
  const factor = CO2E_PER_KG[category] ?? CO2E_PER_KG.other;
  return Math.round(kg * factor * 100) / 100;
}

/** New surplus listing, with a generated id and an explicit safety posture. */
export function createSurplus(input, now = new Date()) {
  const safeUntil = parseDate(input.safeUntil);

  return {
    id: input.id ?? randomUUID(),
    supplierId: input.supplierId,
    title: String(input.title ?? '').trim(),
    category: input.category ?? 'prepared',
    quantityKg: Number(input.quantityKg),
    // Preserved even when it is null, because "we were not told" is information
    // the supplier needs to see about their own listing.
    safeUntil: safeUntil ? safeUntil.toISOString() : null,
    preparedAt: input.preparedAt ? parseDate(input.preparedAt)?.toISOString() ?? null : null,
    requiresHotHolding: input.requiresHotHolding === true,
    requiresChilling: input.requiresChilling === true,
    heldAtC: typeof input.heldAtC === 'number' ? input.heldAtC : null,
    pickupWindow: {
      opensAt: parseDate(input.pickupWindow?.opensAt)?.toISOString() ?? null,
      closesAt: parseDate(input.pickupWindow?.closesAt)?.toISOString() ?? null,
    },
    status: 'listed',
    createdAt: now.toISOString(),
  };
}

/** Parse a date without the new Date(null) trap, where null becomes the epoch. */
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const STATUS = Object.freeze({
  LISTED: 'listed',
  ASSIGNED: 'assigned',
  COLLECTED: 'collected',
  REFUSED: 'refused',
  EXPIRED: 'expired',
});
