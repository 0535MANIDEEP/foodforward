import { assessSurplus, kgToMeals, parseDate, REASON } from './safety.js';

/**
 * ROUTING
 * =======
 *
 * Given a surplus listing, decide which shelter hub should take it. Three things
 * make this more than a sort by distance:
 *
 *   CAPACITY. A hub that feeds 40 people a day cannot absorb 200kg of surplus
 *   because it is the closest one. Ranking on distance alone quietly fills one
 *   hub and starves the rest, and then that hub starts refusing and the food
 *   goes in the bin.
 *
 *   TIME. A hub closed at 10pm cannot collect at 11pm, however much it wants the
 *   food and however near it is. A pickup window that does not overlap the hub's
 *   opening hours is not a match.
 *
 *   SAFETY. Checked by the caller before we get here, and re-checked in the
 *   transaction, because an expired listing in the queue is not a hypothetical.
 *
 * The ranking is a score rather than a sort, so a near hub that is slightly
 * over capacity can still lose to a slightly further hub with room. The weights
 * are named and overridable rather than buried, because they encode a judgement
 * about what matters and that judgement belongs to whoever is running this, not
 * to a developer who picked round numbers.
 */

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km. Null when either point is missing. */
export function distanceKm(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat);
  const lon1 = Number(a.lon);
  const lat2 = Number(b.lat);
  const lon2 = Number(b.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;

  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const DEFAULT_WEIGHTS = Object.freeze({
  // Distance dominates, but not overwhelmingly. A hub 2km further with real
  // spare capacity is a better outcome than the closest one that is already full.
  distance: 1.0,
  // Utilisation after taking this load. An empty hub is a good destination.
  headroom: 0.6,
  // A hub that already handles this category is a better fit than one that
  // cannot store or serve it at all.
  categoryFit: 0.8,
  // Tighter pickup windows are harder to honour, so they are penalised.
  timePressure: 0.3,
});

/**
 * Can this hub physically take this food, ignoring how far away it is?
 *
 * Returns a reason on refusal rather than a boolean, so a hub that declines can
 * say why. A supplier staring at "no hub available" learns nothing and does not
 * report back with better information.
 */
export function hubCanReceive(hub, surplus, { gramsPerMeal = 250, now = new Date() } = {}) {
  const reasons = [];

  if (hub?.active === false) {
    reasons.push({ reason: 'hub_inactive', detail: `${hub.name} is not currently accepting deliveries.` });
  }

  // Capacity. Meals the hub can still take today, against meals this lot is worth.
  const mealsNeeded = kgToMeals(surplus.quantityKg, gramsPerMeal);
  const dailyCapacity = Number(hub?.dailyCapacityMeals ?? 0);
  const alreadyCommitted = Number(hub?.committedMealsToday ?? 0);
  const remaining = dailyCapacity - alreadyCommitted;

  if (!Number.isFinite(dailyCapacity) || dailyCapacity <= 0) {
    reasons.push({ reason: 'no_capacity_recorded', detail: `${hub?.name} has no daily capacity recorded.` });
  } else if (remaining <= 0) {
    reasons.push({
      reason: 'at_capacity',
      detail: `${hub.name} is at capacity for today (${alreadyCommitted} of ${dailyCapacity} meals committed).`,
    });
  } else if (mealsNeeded > remaining) {
    reasons.push({
      reason: 'insufficient_capacity',
      detail: `${hub.name} has room for ${remaining} meals, this lot is ${mealsNeeded}.`,
      remaining,
      mealsNeeded,
    });
  }

  // Can the hub handle this kind of food at all.
  const accepts = hub?.accepts ?? [];
  if (Array.isArray(accepts) && accepts.length > 0 && !accepts.includes(surplus.category)) {
    reasons.push({
      reason: 'category_not_accepted',
      detail: `${hub.name} does not accept ${surplus.category}.`,
    });
  }

  // Opening hours against the pickup window.
  const opensAt = parseDate(hub?.openingHours?.opensAt);
  const closesAt = parseDate(hub?.openingHours?.closesAt);
  const windowOpens = parseDate(surplus.pickupWindow?.opensAt);
  const windowCloses = parseDate(surplus.pickupWindow?.closesAt);

  if (opensAt && closesAt && windowOpens && windowCloses) {
    const overlap = windowOpens <= closesAt && windowCloses >= opensAt;
    if (!overlap) {
      reasons.push({
        reason: 'no_time_overlap',
        detail: `${hub.name} is open ${opensAt.toISOString().slice(11, 16)} to ${closesAt.toISOString().slice(11, 16)}, which does not overlap the pickup window.`,
      });
    }
  } else if (windowOpens && now < windowOpens) {
    reasons.push({
      reason: REASON.NOT_YET_READY,
      detail: 'The pickup window has not opened yet.',
    });
  }

  return { canReceive: reasons.length === 0, reasons, mealsNeeded, remainingCapacity: remaining };
}

/**
 * Rank the hubs that can take this lot, best first.
 *
 * Rejected hubs are returned too, with their reasons. Dropping them silently is
 * how a routing system becomes impossible to debug, and this one will
 * occasionally route nothing and the operator needs to know why.
 */
export function rankHubs(surplus, hubs, { gramsPerMeal = 250, now = new Date(), weights = {} } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const mealsNeeded = kgToMeals(surplus.quantityKg, gramsPerMeal);

  const assessed = hubs.map((hub) => {
    const check = hubCanReceive(hub, surplus, { gramsPerMeal, now });
    const km = distanceKm(surplus.location, hub.location);

    if (!check.canReceive) {
      return { hub, eligible: false, reasons: check.reasons, distanceKm: km, score: null };
    }

    // Normalise distance against the furthest eligible hub, so the scale does not
    // change meaning between a city and a neighbourhood.
    const dailyCapacity = Number(hub.dailyCapacityMeals) || 1;
    const headroom = Math.max(0, (check.remainingCapacity - mealsNeeded) / dailyCapacity);
    const timePressure = pickupWindowHours(surplus.pickupWindow);

    const score =
      (km === null ? 0.5 : km) * w.distance -
      headroom * w.headroom * 10 -
      (Array.isArray(hub.accepts) && hub.accepts.includes(surplus.category) ? w.categoryFit * 5 : 0) +
      timePressure * w.timePressure;

    return {
      hub,
      eligible: true,
      reasons: [],
      distanceKm: km,
      score: Math.round(score * 1000) / 1000,
      headroom: Math.round(headroom * 100) / 100,
      mealsNeeded: check.mealsNeeded,
    };
  });

  const eligible = assessed.filter((a) => a.eligible);
  const furthestKm = eligible.reduce((m, a) => Math.max(m, a.distanceKm ?? 0), 0) || 1;

  // Second pass, now that the distance scale is known.
  for (const a of eligible) {
    const normDistance = (a.distanceKm ?? furthestKm) / furthestKm;
    a.normalisedScore = Math.round(
      (normDistance * w.distance * 100 - a.headroom * w.headroom * 100) * 100,
    ) / 100;
  }

  eligible.sort((a, b) => {
    if (a.normalisedScore !== b.normalisedScore) return a.normalisedScore - b.normalisedScore;
    // Closest wins a tie, because a shorter journey is better for the driver.
    return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
  });

  return { eligible, rejected: assessed.filter((a) => !a.eligible) };
}

/**
 * The single best destination, or a refusal that says why.
 *
 * Safety is re-evaluated here rather than trusted from the caller, because this
 * is the function the transaction calls and the queue may hold a listing that was
 * safe when it was submitted and is not now.
 */
export function routeSurplus(surplus, hubs, options = {}) {
  const { now = new Date() } = options;

  const safety = assessSurplus(surplus, now);
  if (!safety.safe) {
    return {
      routed: false,
      reason: safety.reasons[0].reason,
      reasons: safety.reasons,
      // Recorded, never silently dropped. The supplier needs to see this.
      outcome: 'refused_unsafe',
    };
  }

  const { eligible, rejected } = rankHubs(surplus, hubs, { ...options, now });

  if (eligible.length === 0) {
    return {
      routed: false,
      outcome: 'no_eligible_hub',
      reason: rejected.length === 0 ? 'no_hubs_registered' : 'all_hubs_declined',
      reasons: dedupeReasons(rejected.flatMap((r) => r.reasons)),
      // The best explanation, so an operator is not left guessing.
      nearestMiss: rejected
        .slice()
        .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))[0]?.reasons?.[0] ?? null,
    };
  }

  const best = eligible[0];
  return {
    routed: true,
    outcome: 'assigned',
    hubId: best.hub.id,
    hubName: best.hub.name,
    distanceKm: best.distanceKm === null ? null : Math.round(best.distanceKm * 100) / 100,
    meals: best.mealsNeeded,
    score: best.normalisedScore,
    // Kept so a coordinator can see the road not taken without re-running anything.
    alternatives: eligible.slice(1, 4).map((a) => ({
      hubId: a.hub.id,
      hubName: a.hub.name,
      distanceKm: a.distanceKm === null ? null : Math.round(a.distanceKm * 100) / 100,
      score: a.normalisedScore,
    })),
    rejectedCount: rejected.length,
  };
}

function pickupWindowHours(window) {
  const opens = parseDate(window?.opensAt);
  const closes = parseDate(window?.closesAt);
  if (!opens || !closes) return 0;
  const hours = (closes.getTime() - opens.getTime()) / 3_600_000;
  // A tight window is harder to honour, so it raises the cost.
  return hours <= 0 ? 4 : Math.max(0, 1 - hours / 8);
}

function dedupeReasons(reasons) {
  const seen = new Map();
  for (const r of reasons) {
    if (!seen.has(r.reason)) seen.set(r.reason, r);
  }
  return [...seen.values()];
}

/**
 * Split a day into windows and fill them hub by hub, best score first.
 *
 * This is what actually reduces waste. Routing one lot to the single nearest hub
 * is easy; the case that matters is six lots and two hubs with room for three
 * each, where greedy nearest-first strands food that a slightly worse match could
 * have taken.
 */
export function allocateDay(lots, hubs, { gramsPerMeal = 250, now = new Date() } = {}) {
  const state = new Map(
    hubs.map((h) => [
      h.id,
      {
        ...h,
        committedMealsToday: Number(h.committedMealsToday ?? 0),
        assigned: [],
      },
    ]),
  );

  const unplaced = [];

  // Ordered so the most constrained lots are placed first. A lot with a tight
  // window has fewer chances, and placing it late is what strands it.
  const ordered = lots.slice().sort((a, b) => {
    const aHours = windowHours(a);
    const bHours = windowHours(b);
    if (aHours !== bHours) return aHours - bHours;
    return b.quantityKg - a.quantityKg;
  });

  // Routed one at a time against the live hub state, and placed immediately.
  // Deciding every lot up front looks equivalent and is not: with the decisions
  // made in advance each lot sees the same remaining capacity, so all of them
  // pick the same best hub and the day's allocation sails straight past the
  // capacity it exists to respect.
  for (const lot of ordered) {
    const result = routeSurplus(lot, [...state.values()], { gramsPerMeal, now });

    if (!result.routed) {
      unplaced.push({ lot, result });
      continue;
    }

    const hub = state.get(result.hubId);
    // Meals, not lot count. Adding assigned.length inflated the running total
    // on every placement.
    hub.committedMealsToday = hub.committedMealsToday + result.meals;
    hub.assigned.push({ surplusId: lot.id, meals: result.meals, hubId: hub.id });
  }

  return {
    placed: [...state.values()].flatMap((h) => h.assigned),
    hubLoad: [...state.values()].map((h) => ({
      hubId: h.id,
      hubName: h.name,
      dailyCapacityMeals: Number(h.dailyCapacityMeals),
      committedMealsToday: h.committedMealsToday,
      utilisation:
        Number(h.dailyCapacityMeals) > 0
          ? Math.round((h.committedMealsToday / Number(h.dailyCapacityMeals)) * 100) / 100
          : null,
    })),
    unplaced: unplaced.map((u) => ({
      surplusId: u.lot.id,
      reason: u.result.reason,
      detail: u.result.reasons?.[0]?.detail ?? null,
    })),
  };
}

function windowHours(lot) {
  const o = parseDate(lot.pickupWindow?.opensAt);
  const c = parseDate(lot.pickupWindow?.closesAt);
  if (!o || !c) return Number.POSITIVE_INFINITY;
  return (c.getTime() - o.getTime()) / 3_600_000;
}
