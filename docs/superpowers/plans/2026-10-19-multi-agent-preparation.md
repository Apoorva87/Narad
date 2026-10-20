# Multi-agent preparation implementation plan

**Goal:** Replace multiple parallel Codex CLI processes with one bounded Codex coordinator that delegates independent section work to native subagents, while preserving durable resume, semantic review, cancellation, and output quality.

**Design source:** User-approved direction in the 2026-10-19 conversation; no separate specification file.

**Architecture:** Preparation groups unfinished sections into batches. A single Codex CLI request receives a batch, delegates one independent item per subagent, and returns one schema-validated result set. A second batched request independently reviews valid drafts. Failed items return to the queue with precise feedback; approved items are persisted immediately. Claude retains a single-item compatibility path through the same batch protocol.

**Tech stack:** TypeScript, Zod, Codex CLI, Vitest, React.

---

### Task 1: Configure an economical native Codex coordinator

**Files:**
- Modify: `server/agent-runner.ts`
- Modify: `shared/settings.ts`
- Modify: `src/components/SettingsPage.tsx`
- Test: `tests/agent-runner.test.ts`
- Test: `tests/settings.test.ts`

1. Add failing tests for per-request native multi-agent and reasoning configuration.
2. Extend agent requests with explicit multi-agent and Codex reasoning options.
3. Default preparation to `gpt-6-sol`, low reasoning, and three sections per batch; expose low/medium reasoning in Settings.
4. Run the focused runner/settings tests.

### Task 2: Batch authoring and review through one coordinator

**Files:**
- Modify: `server/generation-content.ts`
- Modify: `server/preparation.ts`
- Test: `tests/preparation-jobs.test.ts`

1. Add failing tests proving one author request can cover three task IDs, uses native multi-agent mode, and retries only rejected items.
2. Add exact, task-keyed author and review batch schemas.
3. Replace parallel top-level workers with a FIFO batch queue. Persist every approved section after each review batch and preserve final source order.
4. Make stages state the number of active agents/sections so Stop remains understandable and immediate.
5. Run focused preparation tests.

### Task 3: Remove avoidable mechanical revisions without weakening review

**Files:**
- Modify: `server/generation-content.ts`
- Modify: `shared/settings.ts`
- Test: `tests/generation-content.test.ts`

1. Add a failing test for generated `Host:` / `Expert:` labels in spoken fields.
2. Normalize only structural speaker prefixes before deterministic checks and semantic review.
3. Strengthen the default dialogue instruction while retaining the independent semantic reviewer for correctness, visual fidelity, equations, and pedagogy.
4. Run focused content/settings tests.

### Task 4: Verify, review, and deploy safely

**Files:**
- Verify only; fix any files identified by review.

1. Run all unit/integration tests, end-to-end tests, type/build checks, and a controlled Codex multi-agent smoke test.
2. Request one fresh final code review and address findings.
3. Stop the currently active old-process preparation only after verification, rebuild/restart Docker, and confirm health.
4. Continue the interrupted lesson and verify that approved sections are reused by the new multi-agent run.

**Execution ruling:** Work in the current checkout because this repository already contains the active user-requested preparation changes and the live Docker service. Do not create commits unless the user asks.
