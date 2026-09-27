import { badRequest } from './errors.js';

/**
 * Validation.
 *
 * Hand written rather than pulled from a schema library, because the only thing
 * that needs validating here is "is this field present and of the right shape",
 * and a dependency for that is a dependency to keep updated forever.
 *
 * The one rule that is not cosmetic: safeUntil may be ABSENT, and absent means
 * the supplier did not say. It is never defaulted, because a default date is the
 * difference between food that is routed to a family and food that is not.
 */

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const validators = {
  string: (value, field, { min = 1, max = 500, pattern = null, label = null } = {}) => {
    if (typeof value !== 'string') throw badRequest(`${label ?? field} is required.`, { field });
    const trimmed = value.trim();
    if (trimmed.length < min) throw badRequest(`${label ?? field} is required.`, { field });
    if (trimmed.length > max) throw badRequest(`${label ?? field} is too long.`, { field });
    if (pattern && !pattern.test(trimmed)) throw badRequest(`${label ?? field} is not valid.`, { field });
    return trimmed;
  },

  optionalString: (value, field, opts = {}) => {
    if (value === undefined || value === null || value === '') return null;
    return validators.string(value, field, opts);
  },

  enum: (value, field, allowed, label = null) => {
    if (!allowed.includes(value)) {
      throw badRequest(`${label ?? field} must be one of: ${allowed.join(', ')}.`, { field, allowed });
    }
    return value;
  },

  number: (value, field, { min = -Infinity, max = Infinity, label = null } = {}) => {
    const n = typeof value === 'string' ? Number(value) : value;
    if (!isFiniteNumber(n)) throw badRequest(`${label ?? field} must be a number.`, { field });
    if (n < min || n > max) {
      throw badRequest(`${label ?? field} must be between ${min} and ${max}.`, { field, min, max });
    }
    return n;
  },

  optionalNumber: (value, field, opts = {}) => {
    if (value === undefined || value === null || value === '') return null;
    return validators.number(value, field, opts);
  },

  /**
   * A date, or null.
   *
   * null is a legitimate and important answer here. The caller decides whether
   * absence is allowed, and for a safe-until time it is, because "we were not
   * told" is information the routing engine needs.
   */
  date: (value, field, { label = null } = {}) => {
    if (value === undefined || value === null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest(`${label ?? field} is not a valid date.`, { field });
    return d.toISOString();
  },

  requiredDate: (value, field, opts = {}) => {
    const d = validators.date(value, field, opts);
    if (d === null) throw badRequest(`${opts.label ?? field} is required.`, { field });
    return d;
  },

  array: (value, field, { allowed = null, label = null } = {}) => {
    if (!Array.isArray(value)) throw badRequest(`${label ?? field} must be a list.`, { field });
    if (allowed) {
      for (const item of value) {
        if (!allowed.includes(item)) {
          throw badRequest(`${label ?? field} contains an unknown value: ${item}.`, { field, allowed });
        }
      }
    }
    return value;
  },

  time: (value, field, { label = null } = {}) => {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) {
      throw badRequest(`${label ?? field} must be a HH:MM time.`, { field });
    }
    return value.length === 5 ? `${value}:00` : value;
  },
};

const PHONE = /^\+?[\d\s-]{10,15}$/;
const GROUPS = ['prepared', 'bakery', 'produce', 'dairy', 'meat', 'other'];

export const schemas = {
  supplier: (body) => ({
    name: validators.string(body.name, 'name', { min: 2, max: 120 }),
    kind: body.kind === undefined ? 'restaurant' : validators.enum(body.kind, 'kind', ['restaurant', 'event', 'caterer', 'other']),
    contactName: validators.string(body.contactName, 'contactName', { min: 2, max: 120, label: 'Contact name' }),
    phone: validators.string(body.phone, 'phone', { pattern: PHONE, label: 'Phone number' }),
    email: validators.optionalString(body.email, 'email', { max: 160 }),
    address: validators.optionalString(body.address, 'address', { max: 255 }),
    city: validators.optionalString(body.city, 'city', { max: 80 }) ?? '',
    state: validators.optionalString(body.state, 'state', { max: 80 }) ?? '',
    lat: validators.optionalNumber(body.lat, 'lat', { min: -90, max: 90 }),
    lon: validators.optionalNumber(body.lon, 'lon', { min: -180, max: 180 }),
  }),

  hub: (body) => {
    const out = {
      name: validators.string(body.name, 'name', { min: 2, max: 160 }),
      organisation: validators.string(body.organisation, 'organisation', { min: 2, max: 160, label: 'Organisation' }),
      contactName: validators.string(body.contactName, 'contactName', { min: 2, max: 120, label: 'Contact name' }),
      phone: validators.string(body.phone, 'phone', { pattern: PHONE, label: 'Phone number' }),
      address: validators.optionalString(body.address, 'address', { max: 255 }),
      city: validators.optionalString(body.city, 'city', { max: 80 }) ?? '',
      state: validators.optionalString(body.state, 'state', { max: 80 }) ?? '',
      lat: validators.optionalNumber(body.lat, 'lat', { min: -90, max: 90 }),
      lon: validators.optionalNumber(body.lon, 'lon', { min: -180, max: 180 }),
      dailyCapacityMeals: body.dailyCapacityMeals === undefined
        ? 0
        : validators.number(body.dailyCapacityMeals, 'dailyCapacityMeals', { min: 0, max: 100000, label: 'Daily capacity in meals' }),
      opensAt: body.opensAt === undefined ? '09:00:00' : validators.time(body.opensAt, 'opensAt', { label: 'Opening time' }),
      closesAt: body.closesAt === undefined ? '21:00:00' : validators.time(body.closesAt, 'closesAt', { label: 'Closing time' }),
      accepts: body.accepts === undefined ? GROUPS : validators.array(body.accepts, 'accepts', { allowed: GROUPS }),
      active: body.active !== false,
    };
    if (out.opensAt >= out.closesAt) {
      throw badRequest('A hub must close after it opens.', { field: 'closesAt' });
    }
    return out;
  },

  surplus: (body) => {
    const pickupWindow = body.pickupWindow ?? {};
    const out = {
      supplierId: validators.string(body.supplierId, 'supplierId', { label: 'Supplier' }),
      title: validators.string(body.title, 'title', { min: 2, max: 160 }),
      category: body.category === undefined ? 'prepared' : validators.enum(body.category, 'category', GROUPS),
      quantityKg: validators.number(body.quantityKg, 'quantityKg', { min: 0.01, max: 5000, label: 'Quantity in kg' }),
      // Absent is allowed and means "not recorded". It is never defaulted to
      // now, or to the end of the shift, because any of those would turn
      // "we do not know" into a date the routing engine would then trust.
      safeUntil: validators.date(body.safeUntil, 'safeUntil', { label: 'Safe until' }),
      preparedAt: validators.date(body.preparedAt, 'preparedAt', { label: 'Prepared at' }),
      requiresHotHolding: body.requiresHotHolding === true,
      requiresChilling: body.requiresChilling === true,
      heldAtC: validators.optionalNumber(body.heldAtC, 'heldAtC', { min: -50, max: 100, label: 'Holding temperature' }),
      pickupWindow: {
        opensAt: validators.date(pickupWindow.opensAt, 'pickupWindow.opensAt', { label: 'Pickup window opens' }),
        closesAt: validators.date(pickupWindow.closesAt, 'pickupWindow.closesAt', { label: 'Pickup window closes' }),
      },
      lat: validators.optionalNumber(body.lat, 'lat', { min: -90, max: 90 }),
      lon: validators.optionalNumber(body.lon, 'lon', { min: -180, max: 180 }),
    };

    const { opensAt, closesAt } = out.pickupWindow;
    if (opensAt && closesAt && closesAt <= opensAt) {
      throw badRequest('The pickup window must close after it opens.', { field: 'pickupWindow' });
    }
    return out;
  },

  collection: (body) => {
    const status = body.status === undefined ? 'collected' : validators.enum(body.status, 'status', ['scheduled', 'collected', 'cancelled', 'missed']);
    const out = {
      assignmentId: validators.string(body.assignmentId, 'assignmentId', { label: 'Assignment' }),
      status,
      collectedKg: validators.optionalNumber(body.collectedKg, 'collectedKg', { min: 0, max: 5000, label: 'Collected weight' }),
      collectedMeals: body.collectedMeals === undefined
        ? null
        : validators.number(body.collectedMeals, 'collectedMeals', { min: 0, max: 1000000, label: 'Collected meals' }),
      notes: validators.optionalString(body.notes, 'notes', { max: 500 }),
    };
    if (status === 'collected' && out.collectedKg === null && out.collectedMeals === null) {
      throw badRequest('A completed collection must record a weight or a meal count.', { field: 'collectedKg' });
    }
    return out;
  },
};

/** Middleware that replaces req.body with the validated result. */
export function validate(schema) {
  return (req, _res, next) => {
    try {
      req.body = schema(req.body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
}
