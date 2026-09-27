import 'dotenv/config';

import express from 'express';
import cors from 'cors';

import { createPool, migrate, ensureDatabase, ping } from './db/client.js';
import { createApi } from './http/api.js';
import { errorHandler } from './http/errors.js';

/**
 * Server assembly, as a factory that does not listen.
 *
 * Exported rather than self starting so the tests drive the real app over a real
 * socket. Calling handlers directly skips the middleware chain, which is how a
 * body limit, a CORS refusal or a 404 handler goes unnoticed.
 */

export function createApp({ pool, gramsPerMeal = 250, allowedOrigins = [] } = {}) {
  const app = express();

  // Behind one proxy, so req.ip is the caller's address for logging. Exactly one
  // hop, because trusting more lets a caller forge the header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // A tight limit. Every body here is a few fields, so a large one is not a real
  // request and an unbounded parser is the cheapest denial of service there is.
  app.use(express.json({ limit: '32kb' }));

  // Explicit allowlist rather than reflecting the caller's Origin. Reflecting it
  // alongside credentials is what lets any website a user visits make
  // authenticated requests here.
  const allow = new Set(allowedOrigins.filter(Boolean));
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // same origin and curl send none
        return callback(null, allow.has(origin));
      },
      methods: ['GET', 'POST'],
    }),
  );

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use('/api', createApi({ pool, gramsPerMeal }));

  app.use((req, res) => {
    res.status(404).json({
      type: 'urn:foodforward:not_found',
      title: 'Not found',
      status: 404,
      detail: `No route for ${req.method} ${req.path}.`,
    });
  });

  app.use(errorHandler(console));

  return app;
}

/** Boot: create the database if needed, apply the schema, then listen. */
export async function start() {
  await ensureDatabase();
  const pool = createPool();
  await migrate(pool);

  const port = Number(process.env.PORT ?? 4000);
  const app = createApp({
    pool,
    gramsPerMeal: Number(process.env.GRAMS_PER_MEAL ?? 250),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  });

  const server = app.listen(port, () => {
    console.log(`[foodforward] listening on http://localhost:${port}`);
    ping(pool)
      .then((ok) => console.log(`[foodforward] mysql ${ok ? 'connected' : 'unreachable'}`))
      .catch(() => console.log('[foodforward] mysql unreachable'));
  });

  const shutdown = async (signal) => {
    console.log(`\n[${signal}] shutting down`);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, pool, app };
}

// Only start when run directly, so importing this in a test does not bind a port.
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  start().catch((err) => {
    console.error('[foodforward] failed to start:', err.message);
    process.exit(1);
  });
}
