# Analysis Recovery and Local Debugging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent false structural review failures, reuse compatible approved analysis sections after API or container restarts, and provide a local development launcher with the same lifecycle commands as the Docker launcher.

**Architecture:** Deterministic TypeScript validation remains authoritative for JSON structure and visual dialogue counts; model review remains authoritative for semantic fidelity. Preparation retries scan prior jobs for approved sections and reuse only sections whose source-derived hash matches the current teaching task. `start_local.sh` supervises the existing `npm run dev` process through a small Node process-group wrapper and keeps PID/log state under `.narad/`.

**Tech Stack:** Bash, Node.js 24+, TypeScript, Zod, Vitest, existing Codex/Claude CLI runners.

**Spec:** User-approved chat design plus the resumability rules in `docs/superpowers/specs/2026-10-19-library-folders-design.md`.

## Global Constraints

- Preserve unrelated uncommitted work in the current checkout.
- Do not automatically resume provider calls after startup; the user explicitly starts a retry.
- Reuse an approved section only when its current source/task hash matches the saved task hash.
- Do not weaken semantic review or suppress factual, attribution, label, quantity, or caveat feedback.
- Local development uses host Codex/Claude credentials and the existing local speech worker; Docker credentials remain isolated in the Docker volume.
- Do not commit unless the user asks.

## Review Focus

1. Reviewer reports 14 visual turns when parsed draft has 12 → ignore only that contradicted structural issue and accept the otherwise valid section.
2. Reviewer reports a real semantic visual issue alongside a false turn-count issue → retain the semantic issue and require revision.
3. Previous approved section exists but source text or asset identity changed → regenerate it.
4. API/container restarts after one section completed → a manually started retry reuses the completed section and begins with the first unfinished section.
5. Stale PID file in local launcher → report stopped and never signal an unrelated process.

---

### Task 1: Reconcile deterministic and model review

**Files:**
- Modify: `server/generation-content.ts`, `server/preparation.ts`, `shared/settings.ts`
- Test: `tests/generation-content.test.ts`, `tests/preparation-jobs.test.ts`

**Interfaces:**
- Produces: `reconcileReviewIssues(teaching, issues): string[]`, which removes only machine-disproved visual dialogue-count complaints.

- [x] Write regression tests for a 12-turn visual rejected as 14 turns and for a mixed false-count plus genuine semantic issue.
- [x] Run the focused tests and confirm they fail for the expected reason.
- [x] Implement issue reconciliation and tell the reviewer not to re-check deterministic structure/count rules.
- [x] Run the focused tests and confirm they pass.

### Task 2: Reuse compatible approved sections after restart

**Files:**
- Modify: `server/generation-content.ts`, `server/preparation.ts`
- Test: `tests/preparation-jobs.test.ts`

**Interfaces:**
- Produces: `teachingTaskHash(task): string` and preparation recovery that copies a compatible prior approved result into the new run before continuing.

- [x] Write a failing integration test in which the first of two sections is approved, the second fails, a fresh `PreparationService` starts a retry, and only the second section invokes the author.
- [x] Add a source-change test proving stale approved work is regenerated.
- [x] Run the focused tests and confirm the failures.
- [x] Implement latest-first compatible recovery from prior job folders and update completed progress as reused sections are encountered.
- [x] Run the focused tests and confirm they pass.

### Task 3: Local launcher and debugging documentation

**Files:**
- Create: `start_local.sh`, `scripts/local-dev-daemon.mjs`
- Modify: `README.md`
- Test: `tests/deployment.test.ts`

**Interfaces:**
- `./start_local.sh start|restart|kill|status|logs|login codex|claude`
- Runtime state: `.narad/local.pid`, `.narad/local.log`; `NARAD_LOCAL_RUNTIME_DIR` may isolate state for diagnostics/tests.

- [x] Write a failing launcher test that executes `status` against an empty temporary runtime directory and validates the command contract.
- [x] Run the focused test and confirm it fails because the launcher is missing.
- [x] Implement the foreground-process supervisor, health polling, stale-PID protection, log command, and host-provider login commands.
- [x] Document local and container debugging commands, credential separation, ports, data paths, and the need to stop Docker before local development.
- [x] Run shell syntax checks and focused tests.

### Task 4: Verification

- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Run `npm run test:e2e -- --reporter=dot`.
- [x] Exercise `./start_local.sh status` with an isolated runtime directory.
- [x] Verify Docker services remain healthy and inspect the failed analysis artifacts without mutating them.
