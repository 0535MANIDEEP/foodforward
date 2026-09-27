# FoodForward

Redirects surplus food from restaurants and events to nearby shelter hubs.

Surplus with no safe-until time, or one already past, is **refused**. Not warned
about, not flagged in red and routed anyway. Refused inside the database
transaction, so no code path can produce a valid assignment for food that could
make somebody ill.

> A demonstration. Not a food safety authority, and not a service anyone should
> rely on to move real food.

## The published paper

**FoodForward - An Initiative to reduce food wastage**
RVN Vijayanand, D Manideep, B Mohari, D Pramod, K. Spandana Kumari
*International Journal of Emerging Technologies and Innovative Research*,
ISSN 2349-9162, Vol. 11 Issue 4, pp. f645–f647, April 2024.
[JETIR2404570](http://www.jetir.org/papers/JETIR2404570.pdf)

The 2024 paper describes a prototype in HTML, CSS, JavaScript, Node.js and MySQL.
This repository is the expanded implementation: the same MySQL schema, the same
routing rules and the same safety refusals, behind an Express API and a React
interface. The paper is the source of truth for the stack, and nothing here
contradicts it.

## Why the rules are refusals

The one decision that shapes this codebase is that a safety failure stops the
process rather than annotating it.

`safeUntil` is nullable, and nullable means *the supplier did not say*. It is
never defaulted — not to now, not to the end of the shift. A default would be the
difference between food that reaches a family and food that does not, and it would
be a default nobody could see.

The check runs **inside** the assignment transaction, not at the API edge, because
a lot that is safe when it is listed is not necessarily safe an hour later, and a
safety check that stops working as soon as the food does is not a safety check.

The refusal is written in its own transaction *after* the one that rolled back,
because the throw that stops the routing would otherwise roll back the record that
it was stopped. That was a real bug: the audit trail vanished at exactly the
moment anybody needed to know a lot had been offered.

## Double counting

Logging one handover twice would double the impact total, which is the exact
failure this project exists to prevent. Three independent guards:

| Guard | Where |
| --- | --- |
| `UNIQUE (surplus_id)` on `assignments` | a lot cannot be routed twice |
| `UNIQUE (assignment_id)` on `collections` | a handover cannot be logged twice |
| `CHECK (committed_meals_today <= daily_capacity_meals)` | a hub cannot be overfilled |

The database is the enforcement point, not the route handler, because a route
handler is the thing that gets deployed wrong. `test/db.test.js` inserts straight
at the table, bypassing every line of application code, to prove the constraints
fire on their own.

Impact is rebuilt from collection rows on every request rather than read from a
stored total, so the number on the page can always be walked back to the
handovers that produced it. There is no counter anywhere that can drift.

## Check the claims yourself

```bash
git clone https://github.com/0535MANIDEEP/foodforward.git
cd foodforward
npm run test:domain
```

That is the whole setup. **No `npm install`, no database, no configuration.** 69
tests, and they are the ones that matter: the safety refusals, the routing rules and
the impact accounting. `src/domain/` imports nothing from `src/db/` or `src/http/`
and nothing outside Node's standard library, which is why that is possible and why
the same rules could sit behind different storage without being rewritten.

If those pass, the safety claim is not a claim. If you want the database half:

```bash
npm install
npm run migrate
npm test          # 148, including 79 against a real MySQL server
```

## Running it

Requires Node 20+ and a MySQL 8+ server. No Docker, no ORM.

```bash
npm install
npm run migrate          # creates the database and applies the schema
npm run seed:reset       # SAMPLE data, clearly labelled as such
npm start                # API on :4000

cd web
npm install
npm run dev              # interface on :5173, proxying /api to :4000
```

### Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `MYSQL_HOST` | `127.0.0.1` | |
| `MYSQL_PORT` | `3306` | |
| `MYSQL_USER` | `root` | |
| `MYSQL_PASSWORD` | `root` | |
| `MYSQL_DATABASE` | `foodforward` | created on boot if absent |
| `PORT` | `4000` | |
| `GRAMS_PER_MEAL` | `250` | the denominator behind every meals figure |
| `ALLOWED_ORIGINS` | none | comma separated. Empty reflects nothing |

### The frontend build

```bash
cd web
VITE_API_URL=https://foodforward-api.onrender.com npm run build
```

Without `VITE_API_URL` the bundle calls its own origin, which is what the dev
proxy is for. If the API is unreachable the interface says so and shows no
figures, rather than falling back to placeholder numbers.

## The API

All endpoints are unauthenticated. That is stated in `GET /api/about` rather than
left to be discovered, because an open write endpoint that a reader assumes is
moderated is worse than one that admits it. Do not put real data in it.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/about` | what this is, what it is not, the citation |
| `GET` | `/api/health` | app and database reachability |
| `GET` | `/api/surplus` | every lot, each with its safety verdict |
| `POST` | `/api/surplus` | list surplus |
| `GET` | `/api/surplus/:id` | one lot, with the full safety assessment |
| `POST` | `/api/surplus/:id/assign` | route one lot. `409` if it will be refused |
| `POST` | `/api/allocate` | route every listed lot, reporting what did not fit |
| `GET` | `/api/hubs` | capacity, opening hours, accepted categories |
| `POST` | `/api/hubs` | register a hub |
| `GET` | `/api/assignments` | |
| `POST` | `/api/collections` | log a handover. `409` if already logged |
| `GET` | `/api/impact` | the report, rebuilt from rows |

Errors are RFC 7807 problem documents. A safety refusal is a `409` carrying
`past_safe_use` or `no_expiry_recorded`, because a client has to decide between
offering a retry and explaining that the food cannot be sent — and a client that
receives a `500` will retry. A `500` never carries an internal message; there is a
test that probes three endpoints for `select `, `from surplus`, `mysql`, `er_`,
`constraint` and `stack` in the response body.

## Tests

```bash
npm test          # 148 tests
npm run test:api  # 119, against real MySQL over a real socket
npm run test:web  #  29, against the generated stylesheet
```

The API tests drive the real app over a real socket, because calling handlers
directly skips the middleware chain and cannot catch a body limit, a CORS refusal
or a `404` that never fires. The database tests run against a real MySQL server
rather than a substitute, because the constraints under test are MySQL behaviour
worth proving on MySQL.

The stylesheet tests are the unusual ones. Tailwind finds classes by scanning
source text for literal strings and cannot resolve a variable, so a class
assembled from fragments is never generated, the component still renders, the
build still succeeds, and the element quietly loses its styling. `web/responsive.test.js`
builds the app, reads the generated CSS, and asserts that every literal class in
the source was actually emitted. Reintroducing that bug fails four assertions.

That failure mode is not hypothetical. It is how the sibling portfolio lost its
navigation entirely.

## Layout

```
src/
  domain/     safety, routing and impact rules. No I/O, no database, fully unit tested.
  db/         schema.sql, pool and transactions, repositories
  http/       routes, validation, problem documents
  seed.js     SAMPLE data, labelled as sample on every line it prints
web/          React and Tailwind interface
test/         119 tests against real MySQL
```

The domain layer knows nothing about MySQL, which is why the rules can be tested
without it and why the same rules could sit behind a different storage engine
without being rewritten.
