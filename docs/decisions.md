# Key Decisions

Decisions are listed with a short rationale. Each is a contract for the implementation; change one only by updating this file, `AGENTS.md`, and the affected code together.

## D1 — Stack: Node.js + TypeScript + Express + SQLite (node:sqlite) + React/Vite

**Accepted (candidate + agent).** Single language across the whole product, simplest one-command startup, a mainstream framework, and a fast, transactional database driver. Express was chosen over Fastify (candidate preference). React (Vite) over Vue for the frontend.

## D2 — SQLite file DB via Node's built-in `node:sqlite` (not in-memory)

The brief forbids an in-memory store. SQLite satisfies the DB constraint with zero external services. The environment runs Node 24, where the built-in `node:sqlite` (`DatabaseSync`) is stable — a synchronous, single-connection driver that serializes writes, makes idempotency (A2/A3) trivial to get right with a transaction, inserts 100k rows quickly inside one transaction, and requires no native compilation or external dependency (zero install risk for the one-command startup).

## D3 — Actor identity via `X-Actor-Id` header

No login UI. One admin is seeded per tenant; the frontend has an actor switcher (Alice / Bob) that sets the `X-Actor-Id` header on every request. The server resolves the admin email → `tenant_id` via a shared middleware and scopes every query by it.

**Missing / unknown actor.** The header is required on every actor-scoped endpoint. The middleware returns:

- Missing or empty header → HTTP 401 `{ "error": "X-Actor-Id header required" }`.
- Header present but no matching admin → HTTP 401 `{ "error": "Unknown actor" }` (non-revealing).

**Frontend.** Loads the actor list from `GET /api/actors`, persists the selection in `localStorage`, and defaults to the first admin, so a header is always present in normal use. A shared fetch wrapper attaches the header to every request. If no actor is selected, the UI prompts "Select an actor" and does not fire requests; any 401 is rendered in the normal error state.

## D4 — Idempotency for bulk issue

Bulk-issue carries an `Idempotency-Key` header. A table `idempotency_keys` unique on `(tenant_id, key)` stores the request hash and the stored outcome. Rules:

- Key absent → run the operation, store hash + outcome.
- Key present, same payload hash → return the stored outcome (A2).
- Key present, different payload hash → HTTP 409, no second operation, first result untouched (A3).

Concurrent duplicates serialize on the SQLite write transaction, so only one logical operation executes.

**Key generation (frontend).** The key is an *operation identity*, not a payload digest. The frontend mints a fresh `crypto.randomUUID()` the moment the user initiates a bulk-issue for a given course and holds it in state, reusing the same UUID across retries of that operation (double-click, timeout, network retry). It regenerates only when the operation intent changes — a different course, or a new "issue now" action — so issuing the same course again later is a new operation with a new key, never a replay. The server treats the key as opaque, stores a payload hash on first use, and compares hashes on a key hit to detect misuse (A3).

## D5 — UTC storage + IANA timezone + denormalized local date

All instants are stored as UTC ISO-8601 strings (`YYYY-MM-DDTHH:mm:ss.sssZ`). Tenant-local display uses the tenant's IANA zone from the `tenants` row via Node's `Intl.DateTimeFormat` (full ICU tz database — no hardcoded offsets, no server-local time). Sydney observes DST (+10/+11); Perth does not (+8).

The tenant-local **calendar date** is what "sort by issue date" and CSV export use. It is denormalized onto the certificate at issuance (`issued_date_local`, `YYYY-MM-DD` in the tenant's zone) so SQLite can sort by it. Sorting is always a deterministic total order; the final tiebreaker is the certificate `id`.

**Why ISO-8601 strings, not epoch numbers (e.g. nanos).** (1) The spec's demo data and the A5 fixture are written in human-readable UTC, so storing the same format keeps seed data and SQL inspection debuggable. (2) Fixed-width UTC ISO strings sort lexicographically in chronological order, so `issued_at` is directly range- and order-comparable in SQL. (3) Epoch nanoseconds exceed JavaScript's safe-integer range (2^53), so a `number` silently loses precision and a BigInt is neither JSON- nor SQLite-driver-native — the ISO string sidesteps that whole bug class. (4) We do not need nanosecond resolution: the `id` column (not the timestamp) is the ordering tiebreaker, and millisecond precision (`sss`) is ample for issuance, revocation, and audit.

## D6 — CSV export streams in batches and yields to the event loop

Export reads rows with keyset pagination on `(issued_date_local, issued_at, id)` — O(n), no OFFSET — and streams the CSV with backpressure. Between batches the handler `await`s `setImmediate`, so the certificate list endpoint stays responsive while a 100k-row export runs (A6).

## D7 — Serial number format

`CERT-<tenant-slug>-<zero-padded-seq>`: unique, monotonic, human-readable, and a stable secondary ordering key.

## D8 — Verification is a standalone script, not a mandatory framework

`npm run verify` is a single TypeScript script that exercises A1–A7 against the running app and prints PASS/FAIL per scenario. Unit tests are allowed but not required; the script is the fastest path to demonstrate correctness.

## D9 — Quick-start seed and 100k generator are separate

`npm run seed` produces the default demo dataset and is always reproducible. `npm run gen100k` adds 100,000 East certificates without touching or depending on the default dataset's shape, so the two never interfere.
