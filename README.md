# Narad

A local learning workspace for faithful explanations, illustrated walkthroughs, and eventually interactive spoken tutoring.

## Current checkpoint: Part 1 of 4

Implemented:
- Persistent analysis library with search.
- Distinct quick-summary, detailed-walkthrough, and tutor-dialogue reading modes.
- Markdown, mathematics, tables, saved diagrams, captions, and source snapshots.
- Explicitly marked teaching additions.
- Passage/section navigation and saved reading positions per analysis and mode.
- Validated lesson JSON import/export; malformed lessons and duplicate IDs are rejected.
- Responsive desktop/mobile reader, keyboard-accessible controls and dialogs.

Two samples use original teaching notes about Bayesian reasoning and gradient descent. They demonstrate the reader; they are not output from a live research pipeline.

**Not implemented yet:** link/file/topic ingestion, agent generation and session controls (Part 2), speech (Part 3), interactive questions and familiarity adaptation (Part 4). Dialogue in Part 1 is a saved script, not a live tutor conversation.

## Run

Requires Node.js 24 or newer; verified on Node 25.8.1.

    npm install
    npm run dev

Open http://127.0.0.1:5178/. The API runs on port 4318. Both bind to loopback.

For a production build:

    npm run build
    npm start

Then open http://127.0.0.1:4318/. Stop either launch command with Ctrl+C.

No agent credentials or TTS model are needed for Part 1. Fonts and demonstration figures are bundled; saved lessons do not depend on a CDN.

## Data and project structure

| Location | Responsibility |
| --- | --- |
| `shared/lesson.ts` | Versioned lesson validation and shared types |
| `shared/navigation.ts` | Passage navigation across section boundaries |
| `content/samples.json` | Original sample source snapshots and all three mode scripts |
| `public/assets/` | Saved demonstration diagrams |
| `server/store.ts` | SQLite lessons and reading positions |
| `server/app.ts` | Library, import, and progress API |
| `src/components/` | Reader, library, source view, and import UI |
| `data/narad.sqlite` | Local library; created on first run and ignored by Git |

`NARAD_DATA_DIR` overrides the data folder. `NARAD_PORT` overrides the API port. Set `VITE_API_TARGET` when using a different API address in development.

Seeding adds missing sample IDs without overwriting existing analyses. To back up a live database, use SQLite backup facilities; alternatively stop the server before copying the data folder. Export individual lessons from the reader.

## Prepared lesson format

Export a sample from the reader for a complete example. Each document has `version: 1`, a unique analysis `id`, metadata, original `sources`, `assets`, and one or more prepared `modes`.

Each mode contains ordered sections. Sections contain blocks with stable IDs, display content, `spokenText`, an `origin` (`source` or `teaching`), and source references. Block kinds: `text`, `equation`, `figure`, `callout`, and `dialogue`.

Use a distinct analysis ID to import an edited copy. Imports never overwrite existing lessons.

Source-derived blocks require valid source/locator references. Equations retain exact LaTeX alongside explanatory Markdown and narration. Figures refer to assets with captions, alt text, and provenance.

For portable imported images, use embedded PNG/JPEG/WebP data URLs. Paths under `/assets/` refer to files already bundled with this installation. Sample exports retain bundled references; they are not general-purpose asset archives. Missing bundled files are rejected. The request limit is 12 MB.

Raw HTML is not rendered. Markdown image syntax displays an explanatory placeholder: use explicit figure blocks to preserve caption, source, and narration associations.

Structural validation does not certify factual completeness or accuracy. Source extraction, coverage checking, and agent review belong to Part 2.

## Verification

    npm test
    npm run test:e2e
    npm run build

Browser tests use installed Google Chrome, start isolated servers on ports 4319/5179, and create a temporary database. They do not modify the live library.

The KaTeX dependency override aligns transitive copies with the patched direct dependency. The build emits a non-blocking bundle-size advisory because math/Markdown rendering is included in the initial bundle. Code splitting can be considered when the app grows.

## Product decisions and next steps

See [the PRD](docs/superpowers/specs/2026-10-19-narad-design.md), [Part 1 plan](docs/superpowers/plans/2026-10-19-narad-part-1.md), and [progress](docs/progress.md).

1. **Library and reader** — current feedback checkpoint.
2. **Research and generation** — sources to checked lessons; minimal agent session controls.
3. **Local narration** — provisional Qwen3-TTS 1.7B CustomVoice through MLX Audio, subject to listening/latency tests.
4. **Interactive tutor** — contextual questions, illustrated detours, and familiarity adaptations.

User feedback is required before advancing to the next checkpoint.
