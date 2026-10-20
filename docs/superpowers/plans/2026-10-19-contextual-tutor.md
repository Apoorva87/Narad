# Contextual tutor implementation plan

## Part 1 — Contract, context, and persistence

1. Add shared schemas for tutor requests, persisted turns, answer blocks, and speech requests.
2. Add tests for strict output validation, passage context assembly, and SQLite persistence.
3. Implement a dedicated tutor store and context builder without changing lesson preparation state.

## Part 2 — Agent execution and API

1. Extend the existing safe CLI runner with a tutor request kind and an explicit research capability flag.
2. Implement an asynchronous tutor service with progress, cancellation, strict parsing, and prompt construction.
3. Add list, ask, stop, delete, and saved-turn speech routes with API tests.

## Part 3 — Passage message board

1. Add a reader hook and passage-level `Ask tutor` / `Replies` disclosure.
2. Add typed questions, editable browser dictation, provider and scope selection, progress, retry/removal, citations, and follow-up prompts.
3. Render only constrained answer components, including equations, original figures, diagrams, and plots.

## Part 4 — Playback, setup, and verification

1. Add expanded replies to ordinary narration and coordinate interrupted answer playback with the preserved lesson position.
2. Add `ARCHITECTURE.md`, an executable `setup.sh`, and README instructions.
3. Run unit tests, production build, browser tests, and live API checks; repair regressions without changing unrelated work.

