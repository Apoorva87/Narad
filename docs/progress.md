# Progress

2026-10-19: User authorized implementation in at least four feedback checkpoints. Current scope: Part 1 only.

Ruling: implement directly in the existing empty Narad directory, which has no Git checkout; no worktree is needed. A folder/name clarification is pending and does not block contract planning.

Ruling: use local React/Node rather than hosted Sites because the confirmed app must launch local agents and local TTS.

Ruling: prior user confirmation authorizes implementation; no additional general plan-approval gate. Pause after the working Part 1 demonstration as requested.

Pre-flight: shared Lesson contract feeds SQLite storage and reader. Only available modes appear; reading positions are scoped to analysis and mode.

## Part 1 implementation

- Completed contract validation and cross-section navigation; confirmed failing tests before implementation.
- Completed SQLite persistence, bounded JSON imports, exact formula/narration preservation, duplicate rejection and missing-asset rejection. Real database and HTTP tests pass.
- Completed React library and reader, all three sample modes, source snapshots, math/tables/diagrams, import/export, progress restoration and responsive layout.
- Sample source notes are self-authored. No source-extraction or factual coverage guarantee for external papers is claimed.
- Ruling: sample content lives in `content/samples.json` instead of a TypeScript module, making the saved document contract directly inspectable.
- Fonts are bundled locally. KaTeX dependency override removes reported low-severity advisories; npm audit reports zero vulnerabilities.
- Independent builder check: no important unresolved questions.
- Independent code review: one material finding (skip link changed route). Reproduced, fixed by focusing without hash mutation, and verified by regression test.
- Verification: 20 Vitest tests and 8 Playwright browser tests passed; TypeScript and production build passed. Build emits a non-blocking math/Markdown bundle-size advisory.
- Local screenshots in `artifacts/`: library-desktop.png, reader-desktop.png, reader-mobile.png.
- Live preview: http://127.0.0.1:5178/ (API 4318).

**Checkpoint:** Part 1 ready for user feedback. Do not begin Part 2 until feedback is received.
