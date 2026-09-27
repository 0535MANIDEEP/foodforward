/**
 * The API client.
 *
 * One rule throughout: this never invents data. If the API is unreachable the
 * interface says so and shows nothing, because a dashboard that quietly falls
 * back to plausible numbers is indistinguishable from a dashboard reporting
 * real rescues. On a food rescue project that is the difference between a
 * number somebody acts on and a number somebody is misled by.
 */

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, { status, code, reasons, field } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.code = code ?? null;
    this.reasons = reasons ?? [];
    this.field = field ?? null;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch (cause) {
    // A network level failure, so there is no status to report. The distinction
    // matters to the caller: this is not a refusal, it is an absence of answers.
    throw new ApiError('Could not reach the FoodForward API.', { status: 0, code: 'unreachable' });
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(payload?.detail ?? `Request failed with status ${response.status}.`, {
      status: response.status,
      code: payload?.code ?? payload?.type ?? null,
      reasons: payload?.reasons ?? [],
      field: payload?.field ?? null,
    });
  }

  return payload;
}

const get = (path) => request(path);
const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  about: () => get('/api/about'),
  health: () => get('/api/health'),
  impact: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''),
    );
    return get(`/api/impact${q.toString() ? `?${q}` : ''}`);
  },
  hubs: () => get('/api/hubs'),
  suppliers: () => get('/api/suppliers'),
  surplus: (status) => get(`/api/surplus${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  surplusDetail: (id) => get(`/api/surplus/${id}`),
  assignments: () => get('/api/assignments'),
  collections: () => get('/api/collections'),
  assign: (id) => post(`/api/surplus/${id}/assign`),
  allocate: () => post('/api/allocate'),
  recordCollection: (body) => post('/api/collections', body),
};

export const apiBase = BASE || 'same origin (dev proxy)';
