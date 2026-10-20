# Agent preparation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare faithful three-mode lessons from the web app using installed Codex or Claude, with visible progress and minimal stop controls.

**Architecture:** The existing Express process owns one active preparation job and its CLI child at a time. SQLite persists job state; per-job files preserve input, prompts, structured outputs, reviews, and completed sections. The server assembles validated lessons; agents never edit the library. Existing lessons are immutable. No additional supervisor service.

**Tech Stack:** Existing Node, TypeScript, Zod, SQLite, React; child_process without shell interpolation.

**Spec:** ../specs/2026-10-19-narad-design.md (checkpoint 2); user authorized next part after Jalapeño review.

## Global constraints
- Main focus is faithful teaching and preserved visuals, tables, formulas, values, and qualifications.
- Three distinct modes with natural spoken text; foundational familiarity.
- Local single-user app; no hosting, accounts, collaboration, or cloud speech required for version one.
- No separate supervisor service or sophisticated recovery dashboard.
- Existing data and user changes remain intact; work in the existing checkout because the running app and uncommitted prior checkpoint live here.
- Execution approval already supplied by “lets do the next part”; no repeat design permission gate.

## Review focus
- Missing/truncated model output or omitted source units must fail validation without publishing partial lessons.
- Multiple sources must not collide in section/image identifiers; uploaded images must reach vision input.
- Stop, timeout, restart, and late subprocess completion must never publish a cancelled job or signal unrelated processes.
- Missing CLI/authentication and content warnings must be visible and actionable; process counts refer only to app-owned children.
- Local launch endpoints must reject cross-origin writes; prompt content and file paths must not become shell commands.

### Task 1: Preparation contracts and compiler
**Files:** shared/preparation.ts, server/generation-content.ts, server/lesson-preparation.ts, tests/generation-content.test.ts.
**Interfaces:** buildTeachingPlan(bundle) returns source-scoped tasks; compilePreparedBundle(bundle, outputs, summary, id) returns Lesson.
- [x] Write and run failing tests for multi-source ID isolation, image-only preservation, missing explanations, exact tables, numeric coverage.
- [x] Implement source segmentation and bounded structured authoring contracts; preserve existing Jalapeño compiler behavior.
- [x] Run targeted tests and build.

### Task 2: Owned jobs and CLI execution
**Files:** server/agent-runner.ts, server/preparation.ts, server/store.ts, server/app.ts, server/index.ts, tests/preparation-jobs.test.ts, tests/agent-runner.test.ts.
**Interfaces:** PreparationService.start(bundleId, provider), list(), stop(id), shutdown(); AgentRunner.run(request, signal, onSession).
- [x] Write failing tests for exclusive start, stopped-job nonpublication, restart interruption, failed review, retained outputs, invalid provider/origin, and subprocess cleanup.
- [x] Implement provider-specific structured CLI execution, scoped work directories, bounded output/time, actual session counting, graceful stop then forced termination of owned group only.
- [x] Generate per-section teaching, check numbers/structure, request separate content review, generate resource summaries and synthesis, then save atomically.
- [x] Topic-only input discovers sources first; captured warnings block publication rather than disappear. Preserve partial files for inspection/retry.
- [x] Run unit/integration suite.

### Task 3: Web controls and agent entry point
**Files:** src/components/PreparationPanel.tsx, src/App.tsx, src/components/SourcePreview.tsx, src/lib/api.ts, src/styles.css, scripts/narad.ts, .agents/skills/narad-prepare/SKILL.md, tests/preparation.e2e.ts.
**Interfaces:** GET /api/preparation, POST /api/source-bundles/:id/prepare, POST /api/preparation/:id/stop.
- [x] Add browser regression for selecting provider, preparation status, cancellation, and opening a completed lesson.
- [x] Implement compact preparation panel and global app-owned session indicator; poll only while mounted, refresh library on completion.
- [x] Add repository-local skill/CLI entry using the same endpoints; document setup and limits.
- [x] Run tests, build, real provider smoke generation, inspect desktop/mobile UI; independent final review.

## Verification
npm test; npm run test:e2e; npm run build. Actual provider generation requires the installed CLI’s existing login and network. Fixture tests do not stand in for that smoke test. Report unverified provider paths explicitly.

## Execution notes

Implemented in the existing checkout; no worktree or global settings changed. Independent read-only review found four material issues, each reproduced and fixed. Retrying starts from scratch with saved artifacts retained. Codex live article generation passed. Claude schema-dialect compatibility was corrected, but live generation is blocked by its expired OAuth session. Image and final browser checks are recorded in docs/progress.md.
