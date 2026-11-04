# Architecture

## Project layout

```
ocean-ai-oa/
  package.json          npm workspaces root + one-command scripts
  server/               Express + node:sqlite, TypeScript
    src/
      index.ts          app bootstrap, static serving of web/dist
      db.ts             connection, schema, migrations
      seed.ts           quick-start demo data
      tz.ts             tenant-local date/datetime via Intl
      routes/           certificates, export, courses, actors
      services/         issue, revoke, idempotency, export
    scripts/
      generate-100k.ts
      verify.ts
  web/                  React + Vite SPA
  docs/                 decisions, architecture, acceptance scenarios
  AGENTS.md             agent contract (commands, red lines, DoD)
  README.md             reproduction + submission notes
  ai/                   session exports, index, decision log, declaration
  written-answers.md    Section 6 — CANDIDATE ONLY, never edited by AI
```

## Commands (contract — see AGENTS.md for semantics)

- `npm run setup` — install + seed + build web + start (the one documented command).
- `npm run dev` — server (tsx watch) + web (Vite) via concurrently.
- `npm run seed` — (re)initialize the default demo data.
- `npm run gen100k` — add 100,000 East certificates.
- `npm run verify` — run A1–A7 checks, print PASS/FAIL.
- `npm run build` — typecheck server + build web.

## Data model (SQLite)

```sql
CREATE TABLE tenants (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,   -- 'east' | 'west'
  name          TEXT NOT NULL,          -- 'East' | 'West'
  iana_timezone TEXT NOT NULL           -- 'Australia/Sydney' | 'Australia/Perth'
);

CREATE TABLE admins (
  id        INTEGER PRIMARY KEY,
  email     TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id)
);

CREATE TABLE learners (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id)
);

CREATE TABLE courses (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id)
);

CREATE TABLE enrollments (
  id           INTEGER PRIMARY KEY,
  learner_id   INTEGER NOT NULL REFERENCES learners(id),
  course_id    INTEGER NOT NULL REFERENCES courses(id),
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  status       TEXT NOT NULL CHECK (status IN ('completed','incomplete')),
  completed_at TEXT,                     -- UTC ISO when completed
  UNIQUE (learner_id, course_id)
);

CREATE TABLE certificates (
  id                INTEGER PRIMARY KEY,
  serial_number     TEXT NOT NULL UNIQUE,
  learner_id        INTEGER NOT NULL,
  course_id         INTEGER NOT NULL,
  tenant_id         INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','revoked')),
  issued_at         TEXT NOT NULL,       -- UTC ISO
  issued_date_local TEXT NOT NULL,       -- YYYY-MM-DD in tenant tz
  revoked_at        TEXT,                -- UTC ISO, null while active
  UNIQUE (learner_id, course_id)         -- at most one cert per learner+course
);

CREATE TABLE certificate_audit (
  id             INTEGER PRIMARY KEY,
  certificate_id INTEGER NOT NULL REFERENCES certificates(id),
  action         TEXT NOT NULL CHECK (action IN ('issued','revoked')),
  actor_admin_id INTEGER NOT NULL,
  tenant_id      INTEGER NOT NULL,
  acted_at       TEXT NOT NULL           -- UTC ISO
);

CREATE TABLE idempotency_keys (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       TEXT NOT NULL,
  result_json  TEXT,                     -- stored outcome for A2 replay
  created_at   TEXT NOT NULL,
  UNIQUE (tenant_id, key)
);
```

"Already certified" is derived, not a column: an enrollment is eligible iff `status = 'completed'` and no active certificate exists for `(learner_id, course_id)`.

## API surface

All endpoints resolve `X-Actor-Id` → admin → `tenant_id` via shared middleware, and scope by it. A missing or unknown actor returns 401 (non-revealing); see D3.

| Method & path | Purpose |
| --- | --- |
| `GET /api/actors` | Seeded admins for the actor switcher. |
| `GET /api/courses` | Tenant's courses (bulk-issue picker). |
| `GET /api/certificates` | List: `search` (learner name or serial, substring), `sort`, `order`, `page`, `pageSize`. Loading/empty/error states live in the UI. |
| `POST /api/certificates/bulk-issue` | Body `{ courseId }`, header `Idempotency-Key` (client-generated opaque operation id; see D4). Returns per-learner outcomes. |
| `GET /api/certificates/:id` | Detail. Cross-tenant → 404. |
| `POST /api/certificates/:id/revoke` | Revoke (client confirms). Cross-tenant → 404. |
| `GET /api/export/certificates.csv` | Streamed CSV, honors current `search`/`sort`/`order`. |

Sort fields: `learnerName`, `serial`, `courseTitle`, `issueDate`. Every comparator ends with the certificate `id` tiebreaker, so ordering is a stable total order. CSV columns, in order: learner name, course title, serial number, tenant-local issue date (`YYYY-MM-DD`).

## API contract (JSON shapes)

Errors are `{"error":"<message>"}` with the status codes in AGENTS.md. This is the exact contract both the backend and frontend implement.

- `GET /api/actors` → `200 {"actors":[{"email":"alice@east.test","tenant":"East"},{"email":"bob@west.test","tenant":"West"}]}`
- `GET /api/courses` → `200 {"courses":[{"id":1,"title":"Safety 101"}]}` (scoped to actor tenant)
- `GET /api/certificates?search=&sort=&order=&page=&pageSize=`
  - `sort`: `learnerName | serial | courseTitle | issueDate` (default `issueDate`); `order`: `asc | desc` (default `desc`); `page` 1-based (default 1); `pageSize` default 20, max 100
  - → `200 {"items":[{"id","serialNumber","learnerName","courseTitle","status","issuedDateLocal"}], "total":N, "page":1, "pageSize":20}`
  - `search` matches learner name OR serial number, case-insensitive substring
- `POST /api/certificates/bulk-issue` (headers `X-Actor-Id`, `Idempotency-Key`; body `{"courseId":1}`)
  - → `200 {"courseId":1,"outcomes":[{"learnerId","learnerName","status":"issued|skipped|failed","reason":null|"not-completed"|"already-certified"|"<error>"}],"summary":{"issued":n,"skipped":n,"failed":n}}`
  - → `404` if `courseId` not in the actor's tenant (no writes); `409` if the key was reused with a different payload
- `GET /api/certificates/:id` → `200 {"id","serialNumber","learnerName","courseTitle","status","issuedAtLocal":"2026-01-11 00:30","revokedAtLocal":null|"..."}`; `404` if cross-tenant or missing
- `POST /api/certificates/:id/revoke` → `200 {"id","status":"revoked"}` (idempotent: already-revoked returns 200, no duplicate audit); `404` if cross-tenant or missing
- `GET /api/export/certificates.csv?search=&sort=&order=` → `200 text/csv` (streamed); header row `learner_name,course_title,serial_number,issue_date`; `issue_date` is the tenant-local calendar date `YYYY-MM-DD`

## Core algorithms

### Bulk issue + idempotency (A2/A3)

1. Resolve actor → tenant. Verify the course belongs to the tenant (else 409/404, no writes).
2. Open a transaction. Atomically look up `idempotency_keys` on `(tenant_id, key)`.
3. Key absent → compute payload hash, run issuance, store hash + result, commit. Each issuance inserts one certificate and one `issued` audit row.
4. Key present, same hash → return the stored result, commit (replay, no new writes).
5. Key present, different hash → abort with 409.

Concurrent same-key requests serialize on the SQLite write transaction, so exactly one logical operation runs.

### Learner outcomes (A4)

For the chosen course, load enrollments. For each learner: `incomplete` → `skipped: not-completed`; `completed` with an active certificate → `skipped: already-certified`; `completed` without one → issue (`issued`).

### Export (A6)

Stream with keyset pagination on `(issued_date_local, issued_at, id)`. After each batch, write rows to `res` honoring backpressure and `await setImmediate` to keep the event loop free for the list endpoint. The exact matching rows come from the same filtered/ordered query the list uses.

### Revocation (A7)

Flip `status` to `revoked`, set `revoked_at`, and insert exactly one `revoked` audit row. Repeating on an already-revoked certificate is a no-op that writes nothing (no duplicate audit).
