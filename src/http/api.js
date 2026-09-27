import { Router } from 'express';

import {
  createSupplier,
  listSuppliers,
  createHub,
  listHubs,
  createSurplusRow,
  listSurplus,
  getSurplus,
  assignSurplus,
  allocateAll,
  listAssignments,
  recordCollection,
  listCollections,
  toPlanShape,
} from '../db/repo.js';
import { assessSurplus } from '../domain/safety.js';
import { impactForCollection, summariseImpact } from '../domain/impact.js';
import { ping } from '../db/client.js';
import { apiError, badRequest, notFound, conflict } from './errors.js';
import { validate, schemas } from './validate.js';

const ALL_CATEGORIES = ['prepared', 'bakery', 'produce', 'dairy', 'meat', 'other'];

/**
 * What a hub accepts, as a list.
 *
 * An empty `accepts` column means no restriction, not nothing. The routing
 * engine treats it as "all categories", so this expands it to the full list:
 * returning [] would let a client draw a hub that accepts no food, when it
 * accepts all of it.
 */
function acceptsOf(hub) {
  const listed = hub.accepts ? String(hub.accepts).split(',').filter(Boolean) : [];
  return listed.length > 0 ? listed : ALL_CATEGORIES;
}

/**
 * The API.
 *
 * Deliberately unauthenticated. This is a student project and the interesting
 * part is the routing and the safety rules, not an account system, so a login
 * screen in front of it would add a moving part without adding safety. What that
 * means in practice is stated plainly in the about endpoint, because an open
 * write endpoint that a reader assumes is moderated is a worse problem than one
 * that admits it.
 */

export function createApi({ pool, gramsPerMeal = 250 } = {}) {  const api = Router();

  /* ------------------------------------------------------------------ meta */
  api.get('/about', (_req, res) => {
    res.json({
      project: 'FoodForward',
      whatItIs: 'Redirects surplus food from restaurants and events to nearby shelter hubs.',
      whatItIsNot: [
        'Not a food safety authority.',
        'Not a substitute for a commercial kitchen or a charity.',
        'Not a certification that any food is safe to eat.',
      ],
      safetyRule:
        'Surplus with no safe-until time, or one already past, is never routed. That is a refusal in the database transaction, not a warning in the interface.',
      authentication: 'None. Open endpoints, intended for a demonstration or a small pilot. Do not put real data in it.',
      paper: {
        title: 'FoodForward - An Initiative to reduce food wastage',
        authors: 'RVN Vijayanand, D Manideep, B Mohari, D Pramod, K. Spandana Kumari',
        journal: 'International Journal of Emerging Technologies and Innovative Research',
        issn: '2349-9162',
        volume: '11',
        issue: '4',
        pages: 'f645-f647',
        month: 'April 2024',
        id: 'JETIR2404570',
        url: 'http://www.jetir.org/papers/JETIR2404570.pdf',
      },
    });
  });

  api.get('/health', async (_req, res) => {
    try {
      res.json({ status: 'ok', database: (await ping(pool)) ? 'ok' : 'degraded' });
    } catch (err) {
      res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  });

  /* -------------------------------------------------------------- suppliers */

  api.get('/suppliers', async (_req, res, next) => {
    try {
      res.json({ suppliers: await listSuppliers(pool) });
    } catch (err) {
      next(err);
    }
  });

  api.post('/suppliers', validate(schemas.supplier), async (req, res, next) => {
    try {
      const supplier = await createSupplier(pool, req.body);
      res.status(201).json({ supplier });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        next(conflict('A supplier with that phone number already exists.'));
        return;
      }
      next(err);
    }
  });

  /* ------------------------------------------------------------------- hubs */

  api.get('/hubs', async (_req, res, next) => {
    try {
      const hubs = await listHubs(pool);
      res.json({
        hubs: hubs.map((h) => ({
          id: h.id,
          name: h.name,
          organisation: h.organisation,
          city: h.city,
          state: h.state,
          lat: h.lat === null ? null : Number(h.lat),
          lon: h.lon === null ? null : Number(h.lon),
          dailyCapacityMeals: Number(h.daily_capacity_meals),
          committedMealsToday: Number(h.committed_meals_today),
          remainingMeals: Number(h.daily_capacity_meals) - Number(h.committed_meals_today),
          opensAt: h.opens_at,
          closesAt: h.closes_at,
          // Already expanded from "no restriction" to the full list by acceptsOf,
          // so a client can draw the real set rather than implying none.
          accepts: acceptsOf(h),
          active: h.active === 1,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  api.post('/hubs', validate(schemas.hub), async (req, res, next) => {
    try {
      res.status(201).json({ hub: await createHub(pool, req.body) });
    } catch (err) {
      if (err.code === 3819) {
        // MySQL 8 check constraint violation. The message is not passed through,
        // because it names the constraint and the schema.
        next(badRequest('That hub configuration is not valid, for example closing before it opens.'));
        return;
      }
      next(err);
    }
  });

  /* ---------------------------------------------------------------- surplus */

  api.get('/surplus', async (req, res, next) => {
    try {
      const rows = await listSurplus(pool, { status: req.query.status ?? null, limit: 100 });
      res.json({
        surplus: rows.map((r) => {
          const shape = toPlanShape(r);
          return {
            id: r.id,
            supplierId: r.supplier_id,
            title: r.title,
            category: r.category,
            quantityKg: Number(r.quantity_kg),
            safeUntil: shape.safeUntil,
            status: r.status,
            refusalReason: r.refusal_reason,
            pickupOpensAt: shape.pickupWindow.opensAt,
            pickupClosesAt: shape.pickupWindow.closesAt,
            createdAt: r.created_at,
            // Carried on the list, not just the detail endpoint. Without it a lot
            // that the safety rules will refuse is shown as "awaiting a hub",
            // which presents food that can never be routed as merely pending.
            safety: assessSurplus(shape, new Date()),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  api.get('/surplus/:id', async (req, res, next) => {
    try {
      const row = await getSurplus(pool, req.params.id);
      if (!row) {
        next(notFound('No such surplus listing.'));
        return;
      }
      const shape = toPlanShape(row);
      // The safety verdict travels with the listing, so a supplier sees why
      // something will not route before they ask a coordinator.
      res.json({
        surplus: {
          id: row.id,
          title: row.title,
          category: row.category,
          quantityKg: Number(row.quantity_kg),
          safeUntil: shape.safeUntil,
          preparedAt: shape.preparedAt,
          requiresHotHolding: shape.requiresHotHolding,
          requiresChilling: shape.requiresChilling,
          status: row.status,
          refusalReason: row.refusal_reason,
          pickupWindow: shape.pickupWindow,
          location: shape.location,
        },
        safety: assessSurplus(shape, new Date()),
      });
    } catch (err) {
      next(err);
    }
  });

  api.post('/surplus', validate(schemas.surplus), async (req, res, next) => {
    try {
      const row = await createSurplusRow(pool, req.body);
      res.status(201).json({
        surplus: { id: row.id, status: row.status, safeUntil: row.safe_until },
        safety: assessSurplus(toPlanShape(row), new Date()),
      });
    } catch (err) {
      if (err.code === 'ER_NO_REFERENCED_ROW_2') {
        next(badRequest('That supplier does not exist.'));
        return;
      }
      next(err);
    }
  });

  /* ------------------------------------------------------------- assignments */

  api.post('/surplus/:id/assign', async (req, res, next) => {
    try {
      const result = await assignSurplus(pool, req.params.id, { gramsPerMeal });
      res.status(result.assigned ? 200 : 409).json(result);
    } catch (err) {
      if (err.name === 'UnsafeFoodError') {
        // 409, and the reason travels with it. A client needs to know this is a
        // refusal about the food, not a server fault it should retry.
        next(
          conflict('This surplus cannot be routed to anybody.', {
            code: err.reason,
            reasons: err.context?.allReasons ?? [{ reason: err.reason, detail: err.message }],
          }),
        );
        return;
      }
      if (err.code === 'NOT_FOUND') {
        next(notFound('No such surplus listing.'));
        return;
      }
      if (err.code === 'NOT_LISTED') {
        next(conflict(err.message, { code: 'not_listed' }));
        return;
      }
      next(err);
    }
  });

  api.post('/allocate', async (_req, res, next) => {
    try {
      res.json(await allocateAll(pool, { gramsPerMeal }));
    } catch (err) {
      next(err);
    }
  });

  api.get('/assignments', async (_req, res, next) => {
    try {
      const rows = await listAssignments(pool);
      res.json({
        assignments: rows.map((a) => ({
          id: a.id,
          surplusId: a.surplus_id,
          hubId: a.hub_id,
          hubName: a.hub_name,
          supplierName: a.supplier_name,
          title: a.title,
          category: a.category,
          meals: Number(a.meals),
          distanceKm: a.distance_km === null ? null : Number(a.distance_km),
          status: a.status,
          createdAt: a.created_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------------- collections */

  api.get('/collections', async (_req, res, next) => {
    try {
      const rows = await listCollections(pool);
      res.json({
        collections: rows.map((c) => ({
          id: c.id,
          assignmentId: c.assignment_id,
          hubName: c.hub_name,
          status: c.status,
          collectedKg: c.collected_kg === null ? null : Number(c.collected_kg),
          collectedMeals: c.collected_meals === null ? null : Number(c.collected_meals),
          collectedAt: c.collected_at ? new Date(c.collected_at).toISOString() : null,
          category: c.category,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  api.post('/collections', validate(schemas.collection), async (req, res, next) => {
    try {
      const collection = await recordCollection(pool, {
        ...req.body,
        gramsPerMeal,
        now: new Date(),
      });
      res.status(201).json({ collection });
    } catch (err) {
      if (err.code === 'ALREADY_COLLECTED') {
        // The single most important 409 in this API. Logging the same handover
        // twice would double the impact total, which is the exact failure this
        // project exists to prevent.
        next(conflict(err.message, { code: 'already_collected' }));
        return;
      }
      if (err.code === 'NOT_FOUND') {
        next(notFound('No such assignment.'));
        return;
      }
      if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
        next(badRequest('A completed collection must record when it happened.'));
        return;
      }
      next(err);
    }
  });

  /* ------------------------------------------------------------------ impact */

  api.get('/impact', async (req, res, next) => {
    try {
      const rows = await listCollections(pool, { limit: 1000 });

      // Every collection is passed through, including the cancelled and missed
      // ones. Filtering them out here would make excludedNotCollected
      // structurally zero, which reads on the page as "nothing was left out" when
      // in fact the route is hiding it. impactForCollection already gives a
      // non completed handover an impact of exactly zero, and counts it, so the
      // report can say what it deliberately did not include.
      const records = rows.map((c) =>
        impactForCollection({
          collection: {
            id: c.id,
            status: c.status,
            collectedKg: c.collected_kg,
            collectedMeals: c.collected_meals,
            collectedAt: c.collected_at,
          },
          surplus: { category: c.category, supplierId: c.supplier_id },
          hub: { id: c.hub_id, name: c.hub_name },
          gramsPerMeal,
        }),
      );

      res.json(summariseImpact(records, { from: req.query.from ?? null, to: req.query.to ?? null }));
    } catch (err) {
      next(err);
    }
  });

  /* ---------------------------------------------------------------- 404 / err */

  api.use((req, res) => {
    res.status(404).json(apiError(404, 'No such endpoint.', 'not_found', `${req.method} ${req.originalUrl}`));
  });

  return api;
}
