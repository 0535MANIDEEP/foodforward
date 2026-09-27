import { co2eAvoidedKg, kgToMeals, parseDate } from './safety.js';

/**
 * IMPACT ACCOUNTING
 * =================
 *
 * The number a donor or a hostel kitchen actually cares about is "how many people
 * did this feed", so that is the primary figure and everything else is derived
 * from it.
 *
 * The whole risk of an impact page is that it drifts from the data. Two habits
 * prevent that here:
 *
 *   1. Impact is computed from collections, never from listings. Food that was
 *      listed and never collected fed nobody, and counting it is how a food
 *      rescue impact page ends up claiming meals that were eaten by the staff
 *      who logged them.
 *
 *   2. Every figure is traceable to a collection id. summariseImpact takes the
 *      collections, not a stored total, so a number on the page can always be
 *      walked back to the rows that produced it. There is no counter anywhere
 *      that can drift.
 */

export const COLLECTION_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  COLLECTED: 'collected',
  CANCELLED: 'cancelled',
  MISSED: 'missed',
});

/** Build the impact record for one completed collection. */
export function impactForCollection({ collection, surplus, hub, gramsPerMeal = 250, at = new Date() }) {
  if (collection?.status !== COLLECTION_STATUS.COLLECTED) {
    // Not an error. A collection that was cancelled has an impact of zero, and
    // saying so explicitly is better than omitting the row and letting a
    // dashboard sum quietly disagree with itself.
    return {
      collectionId: collection?.id,
      counted: false,
      reason: `collection_${collection?.status ?? 'unknown'}`,
      meals: 0,
      kg: 0,
      co2eKg: 0,
    };
  }

  // Collected weight wins over the listed weight, because what actually left the
  // kitchen is what fed somebody, and the two legitimately differ.
  const kg = Number.isFinite(collection.collectedKg) && collection.collectedKg >= 0
    ? Number(collection.collectedKg)
    : Number(surplus?.quantityKg ?? 0);

  const meals = Number.isInteger(collection.collectedMeals) && collection.collectedMeals >= 0
    ? collection.collectedMeals
    : kgToMeals(kg, gramsPerMeal);

  return {
    collectionId: collection.id,
    counted: true,
    hubId: hub?.id ?? null,
    hubName: hub?.name ?? null,
    supplierId: surplus?.supplierId ?? null,
    category: surplus?.category ?? 'other',
    kg: Math.round(kg * 1000) / 1000,
    meals,
    co2eKg: co2eAvoidedKg(surplus?.category ?? 'other', kg),
    gramsPerMeal,
    at: (parseDate(collection.collectedAt) ?? at).toISOString(),
  };
}

/**
 * Roll collections up into a report.
 *
 * Takes the rows, never a stored total, so the page can be rebuilt from the
 * database at any time and the answer will be the same.
 */
export function summariseImpact(records, { from = null, to = null } = {}) {
  const fromMs = parseDate(from)?.getTime() ?? null;
  const toMs = parseDate(to)?.getTime() ?? null;

  const inRange = records.filter((r) => {
    if (!r?.counted) return false;
    const at = parseDate(r.at)?.getTime();
    if (at === null || at === undefined) return false;
    if (fromMs !== null && at < fromMs) return false;
    if (toMs !== null && at > toMs) return false;
    return true;
  });

  const byHub = new Map();
  const byCategory = new Map();

  for (const r of inRange) {
    const hub = r.hubName ?? 'unknown';
    const h = byHub.get(hub) ?? { hubName: hub, collections: 0, meals: 0, kg: 0, co2eKg: 0 };
    h.collections += 1;
    h.meals += r.meals;
    h.kg = round2(h.kg + r.kg);
    h.co2eKg = round2(h.co2eKg + r.co2eKg);
    byHub.set(hub, h);

    const cat = byCategory.get(r.category) ?? { category: r.category, collections: 0, meals: 0, kg: 0 };
    cat.collections += 1;
    cat.meals += r.meals;
    cat.kg = round2(cat.kg + r.kg);
    byCategory.set(r.category, cat);
  }

  const totals = inRange.reduce(
    (acc, r) => ({
      collections: acc.collections + 1,
      meals: acc.meals + r.meals,
      kg: round2(acc.kg + r.kg),
      co2eKg: round2(acc.co2eKg + r.co2eKg),
    }),
    { collections: 0, meals: 0, kg: 0, co2eKg: 0 },
  );

  return {
    from: from ? parseDate(from).toISOString() : null,
    to: to ? parseDate(to).toISOString() : null,
    totals,
    byHub: [...byHub.values()].sort((a, b) => b.meals - a.meals),
    byCategory: [...byCategory.values()].sort((a, b) => b.meals - a.meals),
    // Stated so a reader can see the denominator, not just a big number.
    excludedNotCollected: records.length - inRange.length,
    basis: 'Completed collections only. Listed or cancelled surplus feeds nobody and is not counted.',
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
