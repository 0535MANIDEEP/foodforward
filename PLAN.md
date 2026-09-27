# FoodForward — build and deploy

## Definition of done

A working full-stack surplus-food redistribution platform, tested against a real
MySQL server, with the frontend deployed and live, and the backend deployable
with one command once a Render key exists. Every claim the portfolio makes about
it is true.

## What the published paper actually says

Verified: `http://www.jetir.org/papers/JETIR2404570.pdf` returns HTTP 200,
application/pdf, 1,010,538 bytes.

- Title: FoodForward — An Initiative to reduce food wastage
- Authors: RVN Vijayanand, D Manideep, B Mohari, D Pramod, K. Spandana Kumari
- Journal: International Journal of Emerging Technologies and Innovative Research
- ISSN 2349-9162, Vol. 11, Issue 4, pp. f645–f647, April 2024
- Abstract stack: **HTML, CSS, JavaScript, Node.js, MySQL**

The paper says MySQL. The portfolio currently claims MongoDB and React with
Tailwind. **The paper is the source of truth and the portfolio gets corrected to
match it**, because a live site that contradicts a published paper is worse than
a modest stack list.

## The one hard safety constraint

This is a food system, so the equivalent of the blood project's clinical rules
is expiry. Surplus food that is past its safe-use time, or whose safe-use time is
unknown, **must not be routed to anybody.** Not warned about, not flagged in the
UI: refused at the point of assignment, in the database, with a test.

Everything else in the routing engine is an optimisation. That one is a refusal.

## Checklist

- [ ] 1. Remove MongoDB deps, add mysql2
- [ ] 2. Domain: food safety rules, fail closed on unknown expiry
- [ ] 3. Domain: capacitated, time-windowed nearest-hub assignment
- [ ] 4. Domain: impact accounting, no double counting
- [ ] 5. MySQL schema with real constraints
- [ ] 6. Repositories, with assignment done in a transaction
- [ ] 7. Express API: suppliers, surplus, hubs, assignments, impact
- [ ] 8. Tests against the real MySQL on localhost:3306
- [ ] 9. Prove the suite fails when the safety rule is removed
- [ ] 10. React + Tailwind frontend
- [ ] 11. Seed data, honest and obviously sample
- [ ] 12. Deploy frontend to GitHub Pages
- [ ] 13. Render blueprint for the backend
- [ ] 14. Correct the portfolio stack and citation, add the real links
- [ ] 15. Verify the live site and the running app in a browser

## Blocked, and only on this

The backend deploy needs a Render API key, which is an account only the owner can
create. Everything else proceeds. The frontend deploys and goes live regardless,
pointing at a configurable API base URL.

## Non-negotiable

- No food is routed past its safe-use time. Ever. Tested.
- No impact figure is reported that the data does not support.
- The portfolio stack list matches what is actually deployed, not what sounds good.
