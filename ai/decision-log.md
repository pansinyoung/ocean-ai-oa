# AI Decision Log

Three material decisions from the session, each traced to the candidate's own review question, the AI's answer, the verification evidence, and the relevant commit. Consistent timezone: UTC.

## Decision 1 — Reviewed edge-case handling: what happens when `X-Actor-Id` is missing

- **Type:** AI design I reviewed and accepted.
- **My question:** "About decision 3, what if the `X-Actor-Id` header is missing? How would backend and frontend handle this case?"
- **Resolution:** The backend's shared actor-resolution middleware requires the header on every actor-scoped endpoint. A missing or empty header returns `401 { "error": "X-Actor-Id header required" }`; a header that matches no admin returns `401 { "error": "Unknown actor" }` (non-revealing). The frontend always sets the header via a shared fetch wrapper and prompts "Select an actor" rather than firing requests when no actor is chosen.
- **Session:** `local_aa1039de-3f38-4516-b4af-6c9ede3c1bd1` (main).
- **Verification:** `npm run verify` — A1 (Bob's actor-scoped requests return 200; unknown/missing actor is rejected before any tenant-scoped query). See `docs/decisions.md` D3.
- **Commit:** `efe6877` — `server/src/app.ts` (`resolveActor` middleware) and the frontend fetch wrapper.

## Decision 2 — Verified the idempotency-key mechanism: how the frontend generates the key

- **Type:** AI design I reviewed and accepted.
- **My question:** "About decision 4, how is the `Idempotency-Key` calculated in the frontend to ensure the nature of idempotency?"
- **Resolution:** The key is an *operation identity*, not a payload digest. The frontend mints a fresh `crypto.randomUUID()` when the user initiates a bulk-issue for a given course and reuses it across retries of that same operation (double-click, timeout, network retry); it regenerates only when the intent changes. The server stores a payload hash on first use and compares hashes on a key hit, so the same key with a different payload returns `409` (A3) while a true retry replays the original outcome (A2).
- **Session:** `local_aa1039de-3f38-4516-b4af-6c9ede3c1bd1` (main).
- **Verification:** `npm run verify` — A2 (12 concurrent identical requests → one logical issuance, identical outcomes) and A3 (same key + different payload → 409, zero writes). See `docs/decisions.md` D4.
- **Commit:** `efe6877` — `server/src/app.ts` (`runBulkIssue`) and the `idempotency_keys` table; frontend `BulkIssue.tsx`.

## Decision 3 — Challenged the timestamp representation: why ISO-8601 strings instead of epoch nanoseconds

- **Type:** Scope/design tradeoff I questioned and confirmed.
- **My question:** "About D5, why do you choose ISO-8601 string over epoch nanoseconds like `1553906700000000000n`?"
- **Resolution:** UTC ISO-8601 strings were chosen because (1) the spec's demo data and the A5 fixture are already human-readable UTC, (2) fixed-width UTC ISO strings sort lexicographically in chronological order, (3) epoch nanoseconds exceed JavaScript's safe-integer range (2^53), so a `number` loses precision and a `BigInt` is neither JSON- nor SQLite-driver-native, and (4) nanosecond resolution is not needed — the `id` column is the ordering tiebreaker and millisecond precision is ample.
- **Session:** `local_aa1039de-3f38-4516-b4af-6c9ede3c1bd1` (main).
- **Verification:** `npm run verify` — A5 (East `2026-01-11 00:30` / West `2026-01-10 21:30`) and A6 (100k export sorted deterministically and byte-identical across runs). See `docs/decisions.md` D5.
- **Commit:** `efe6877` — `server/src/tz.ts` and the DB schema.
