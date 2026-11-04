# AI Interaction Evidence — Completeness Declaration

## Tools used

| Tool | Role | Model |
| --- | --- | --- |
| Claude Code (desktop app) | Main session: planning, design decisions, orchestration, integration, verification, packaging | `claude-fable-5[1m]` |
| Claude Code subagent (Agent tool) — backend | Implemented `server/` (backend, seed, scripts, verification) | `claude-fable-5` (inherited) |
| Claude Code subagent (Agent tool) — frontend | Implemented `web/` (React SPA) | `claude-fable-5` (inherited) |

## Exports

- `ai/sessions/backend-agent.jsonl` — native JSONL transcript of the backend agent (full tool activity: file reads/writes, shell commands, errors, timestamps, model id).
- `ai/sessions/frontend-agent.jsonl` — native JSONL transcript of the frontend agent.
- Main session transcript — exported via Claude Code's "Export transcript" (a zip containing the conversation, subagent transcripts, and session metadata). Its path is recorded in `ai/session-index.csv` (it lives in the user's Downloads folder, not in this repository).

## Export limitations

- The main-session export is produced by Claude Code's export feature and is referenced by path rather than stored inside the repository.
- The two subagent transcripts are the raw JSONL task outputs from the Agent tool — that tool's native export format — and contain the agents' full chronological activity.
- Subagent `started_at`/`ended_at` values in `session-index.csv` are approximate (derived from launch time and transcript file modification time); exact per-message timestamps are inside the raw transcripts.
- No inline autocomplete or other non-exportable assistance was used during this work, so there is nothing additional to disclose on that front.

## Section 6 declaration

Section 6 of the brief ("Written Technical Answers, No AI Assistance") is the candidate's individual work. `written-answers.md` was **not** created, drafted, summarized, translated, rephrased, or proofread by any AI tool during this session. The candidate attests that Section 6 was completed in their own words without AI assistance.
