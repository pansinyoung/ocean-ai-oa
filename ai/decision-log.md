# AI Decision Log

Three material decisions, each linked to the session, verification evidence, and commit. Consistent timezone: UTC.

## Decision 1 — Corrected an earlier choice: `node:sqlite` instead of `better-sqlite3`

- **Type:** AI suggestion that corrected an earlier design choice.
- **What:** The initial design picked `better-sqlite3` (synchronous, single-connection). After checking the actual runtime (Node v24.22.1), I switched to Node's built-in `node:sqlite` (`DatabaseSync`), which is stable in Node 24 and provides the same synchronous/transactional model with zero native compilation and zero extra dependency.
- **Why:** It removes the one real install-failure risk from the one-command startup (`npm run setup`).
- **Session:** `local_aa1039de-3f38-4516-b4af-6c9ede3c1bd1` (main).
- **Verification:** `npm install` completed with no native build step; `npm run build` and `npm run verify` (47/47) pass on the built-in driver.
- **Commit:** `d621c53` — recorded in `docs/decisions.md` D2.

## Decision 2 — Rejected a wrong approach: the idempotency key is an operation identity, not a payload hash

- **Type:** AI suggestion rejected/corrected.
- **What:** The naive approach of deriving the idempotency key from the request payload (`hash(courseId + actor)`) was rejected, because re-issuing the same course later would hash to the same key and replay the old result instead of issuing again. Instead the frontend mints a `crypto.randomUUID()` per operation and reuses it across retries, regenerating only for a new operation; the server stores a payload hash to detect key *misuse* (A3 → 409).
- **Why:** Idempotency must cover retries of one operation, not identity of a payload.
- **Session:** `local_aa1039de-3f38-4516-b4af-6c9ede3c1bd1` (main; clarified in a follow-up question).
- **Verification:** `npm run verify` — A2 (12 concurrent identical requests → one logical issuance, identical outcomes) and A3 (same key + different payload → 409, zero writes).
- **Commit:** `efe6877` — `server/src/app.ts` (`runBulkIssue`) and the `idempotency_keys` table.

## Decision 3 — Design tradeoff: ISO-8601 UTC strings + denormalized `issued_date_local`, over epoch timestamps or SQL-side timezone math

- **Type:** Scope/design tradeoff.
- **What:** All instants are stored as UTC ISO-8601 strings, and a `issued_date_local` column (`YYYY-MM-DD` in the tenant's IANA zone) is denormalized at issuance so SQLite can sort by the tenant-local calendar date. Alternatives considered and rejected: epoch nanoseconds (exceeds JS's 2^53 safe-integer range; not JSON- or SQLite-driver-native) and computing timezone offsets in SQL (SQLite has no IANA timezone database).
- **Why:** Readable, self-describing timestamps that match the spec's fixtures; correct DST via `Intl.DateTimeFormat`; O(1) SQL-sortable local date; deterministic total order with the `id` tiebreaker.
- **Session:** `local_aa1039de-3f38-4516-b4af-6c9ede3c1bd1` (main).
- **Verification:** `npm run verify` — A5 (East `2026-01-11 00:30` / West `2026-01-10 21:30`) and A6 (100k export sorted deterministically, byte-identical across runs).
- **Commit:** `d621c53` (`docs/decisions.md` D5); `efe6877` (`server/src/tz.ts` and the DB schema).
