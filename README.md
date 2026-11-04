# Certificate Admin Console

An internal, multi-tenant admin console for a training platform. Tenant admins list course completions, bulk-issue certificates, revoke them, and export certificate data to CSV.

Built for the Ocean AI Labs technical assessment (version 20261102). Stack: **Node.js 24 + TypeScript + Express 5 + `node:sqlite` (SQLite) + React 19 + Vite**.

## Prerequisites

- Node.js **24+** (the app uses the built-in `node:sqlite` module — no native database driver to compile).
- npm.

## One-command startup

```bash
npm run setup
```

This installs dependencies, seeds the demo data, builds the web app, and starts the complete app on **http://localhost:3000** (the React UI is served at `/`, the API under `/api`).

Individual commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Run server (`tsx watch`) + web (`vite`) together with live reload. |
| `npm run seed` | (Re)initialize the default quick-start demo data. |
| `npm run gen100k` | Generate 100,000 East certificates (does not alter the quick-start dataset's shape). |
| `npm run verify` | Run the A1–A7 acceptance checks and print PASS/FAIL. |
| `npm run build` | Typecheck the server and build the web app. |

## Actor identity

There is no login UI (by design). One admin is seeded per tenant, and the actor is identified by the **`X-Actor-Id`** header:

| Admin | Tenant | IANA timezone |
| --- | --- | --- |
| `alice@east.test` | East | `Australia/Sydney` |
| `bob@west.test` | West | `Australia/Perth` |

A missing or unknown `X-Actor-Id` returns **401**. The web UI has an actor switcher in the header that sets this header on every request.

## Demo data

- Tenants **East** (`Australia/Sydney`) and **West** (`Australia/Perth`).
- Admins `alice@east.test` and `bob@west.test`, each bound only to their own tenant.
- Both tenants contain a course titled **"Safety 101"** and a learner named **"Alex Lee"**, plus four more learners covering **completed**, **incomplete**, and **already-certified** enrollments.
- Two fixture certificates (one per tenant) are issued at UTC `2026-01-10T13:30:00Z` to demonstrate DST (see A5).

## Acceptance scenarios (A1–A7)

`npm run verify` automates all of these (47 checks). Manual reproduction:

### A1 — Tenant isolation

```bash
# Bob (West) cannot read East data:
curl -s -H "X-Actor-Id: bob@west.test" "localhost:3000/api/certificates?pageSize=100"
# → only CERT-west-* serials

# Cross-tenant detail returns 404 (non-revealing):
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Actor-Id: bob@west.test" localhost:3000/api/certificates/1
# → 404

# Cross-tenant bulk-issue is rejected with zero writes:
curl -s -w "\n%{http_code}\n" -X POST -H "X-Actor-Id: bob@west.test" \
  -H "Idempotency-Key: a1-test" -H "Content-Type: application/json" \
  -d '{"courseId":1}' localhost:3000/api/certificates/bulk-issue
# → 404 "Course not found", no certificates/audit rows created
```

### A2 — Retry safety (idempotent bulk issue)

Send the same request with the same `Idempotency-Key` sequentially or concurrently. Only one logical operation runs: each eligible learner receives at most one certificate, each issuance has exactly one audit event, and every caller receives the same outcome. The frontend mints one `crypto.randomUUID()` per operation and reuses it across retries; the server serializes concurrent duplicates on a SQLite write transaction. Verified programmatically by `npm run verify` (12 concurrent identical requests).

### A3 — Idempotency-key misuse

```bash
# First, a successful bulk-issue with key "a3-key" for course 2 (West Safety 101):
curl -s -X POST -H "X-Actor-Id: bob@west.test" -H "Idempotency-Key: a3-key" \
  -H "Content-Type: application/json" -d '{"courseId":2}' localhost:3000/api/certificates/bulk-issue

# Reusing the same key with a DIFFERENT course returns 409 and executes nothing:
curl -s -w "\n%{http_code}\n" -X POST -H "X-Actor-Id: bob@west.test" \
  -H "Idempotency-Key: a3-key" -H "Content-Type: application/json" \
  -d '{"courseId":1}' localhost:3000/api/certificates/bulk-issue
# → 409
```

### A4 — Learner outcomes

Bulk-issuing a course issues only eligible learners; incomplete and already-certified learners are skipped with reasons:

```bash
curl -s -X POST -H "X-Actor-Id: bob@west.test" -H "Idempotency-Key: a4-key" \
  -H "Content-Type: application/json" -d '{"courseId":2}' localhost:3000/api/certificates/bulk-issue
# → outcomes: completed→"issued"; incomplete→"skipped:not-completed";
#   Alex Lee→"skipped:already-certified"
```

### A5 — DST and tenant-local date

Both tenants have a certificate issued at UTC `2026-01-10T13:30:00Z`. The same instant renders differently per tenant:

```bash
curl -s -H "X-Actor-Id: alice@east.test" localhost:3000/api/certificates/1   # issuedAtLocal "2026-01-11 00:30" (Sydney +11)
curl -s -H "X-Actor-Id: bob@west.test"   localhost:3000/api/certificates/2   # issuedAtLocal "2026-01-10 21:30" (Perth +8)
```

List sorting and CSV export use the tenant-local calendar date (`2026-01-11` for East, `2026-01-10` for West).

### A6 — Export growth

```bash
npm run gen100k   # add 100,000 East certificates, all sharing one local date

# Export (honors current search + sort + order), measure with time:
time curl -s -H "X-Actor-Id: alice@east.test" \
  "localhost:3000/api/export/certificates.csv?sort=issueDate&order=desc" -o /tmp/east.csv

# The export streams in batches and yields to the event loop, so the list stays responsive mid-export.
# Repeated exports are byte-identical (deterministic total order with id tiebreak).
```

### A7 — Revocation audit

```bash
# Revoke a certificate (writes exactly one "revoked" audit event):
curl -s -X POST -H "X-Actor-Id: alice@east.test" localhost:3000/api/certificates/1/revoke
# → {"id":1,"status":"revoked"}

# Repeating is a no-op that writes no additional audit event:
curl -s -X POST -H "X-Actor-Id: alice@east.test" localhost:3000/api/certificates/1/revoke
```

## Known limitations / design notes

- **No production authentication** — actor identity is a header, as specified (no login UI, no sessions, no CSRF).
- **One certificate per learner per course, for life.** `certificates` has a `UNIQUE(learner_id, course_id)` constraint, so re-issuing after a revocation is intentionally unsupported (out of the A1–A7 scope). Bulk-issue eligibility checks for an *active* certificate; a hypothetical re-issue after revoke would surface as a `failed` outcome rather than minting a second certificate.
- **Minimal frontend** — no routing library or UI framework, by design (correct core behavior over polish).

## Design documentation

- `docs/architecture.md` — layout, schema, API contract, algorithms.
- `docs/decisions.md` — the key decisions and their rationale.
- `docs/acceptance-scenarios.md` — A1–A7 mapped to implementation and verification.
- `AGENTS.md` — the agent contract (commands, tenant-isolation red line, timezone rule, definition of done).

## AI interaction evidence

- `ai/sessions/` — native exports of the delegated coding agents.
- `ai/session-index.csv` — one row per AI session.
- `ai/decision-log.md` — material decisions with evidence and commits.
- `ai/completeness.md` — tools used, export limitations, and the Section 6 declaration.
