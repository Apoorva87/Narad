# Narad

A local learning workspace for faithful explanations, illustrated walkthroughs, and eventually interactive spoken tutoring.

## Current checkpoint: Part 2A of 4 — source intake

Implemented:
- Veena-inspired Narad logo, drawing on Narada’s musical association.
- Add a lesson from text ideas, multiple article links, uploaded/dropped/pasted images, or a mixture.
- Persistent source collections with ordered article previews, captured visuals, missing-content warnings, and retry/refresh.
- Persistent analysis library with search.
- Distinct quick-summary, detailed-walkthrough, and tutor-dialogue reading modes.
- Markdown, mathematics, tables, saved diagrams, captions, and source snapshots.
- Explicitly marked teaching additions.
- Passage/section navigation and saved reading positions per analysis and mode.
- Validated lesson JSON import/export; malformed lessons and duplicate IDs are rejected.
- Responsive desktop/mobile reader, keyboard-accessible controls and dialogs.

Two samples use original teaching notes about Bayesian reasoning and gradient descent. They demonstrate the reader; they are not output from a live research pipeline.

**Not implemented yet:** PDF/document ingestion, OCR/image interpretation, agent generation and session controls (remaining Part 2), speech (Part 3), interactive questions and familiarity adaptation (Part 4). Dialogue in Part 1 is a saved script, not a live tutor conversation.

## Run

Requires Node.js 24 or newer; verified on Node 25.8.1.

    npm install
    npm run dev

Open http://127.0.0.1:5178/. The API runs on port 4318. Both bind to loopback.

For a production build:

    npm run build
    npm start

Then open http://127.0.0.1:4318/. Stop either launch command with Ctrl+C.

No agent credentials or TTS model are needed for this checkpoint. Fonts and demonstration figures are bundled; saved lessons do not depend on a CDN.

## Data and project structure

| Location | Responsibility |
| --- | --- |
| `shared/lesson.ts` | Versioned lesson validation and shared types |
| `shared/navigation.ts` | Passage navigation across section boundaries |
| `content/samples.json` | Original sample source snapshots and all three mode scripts |
| `public/assets/` | Saved demonstration diagrams |
| `shared/sources.ts` | Source intake and visual inventory contract |
| `server/capture.ts` | Ordered article extraction and safe SVG previews |
| `server/download.ts` | Bounded public-network downloads with pinned DNS and redirect checks |
| `server/store.ts` | SQLite lessons, reading positions, source snapshots, and content-addressed image blobs |
| `server/app.ts` | Library, import, progress, source capture/retry, and saved asset API |
| `src/components/` | Reader, library, source view, and import UI |
| `data/narad.sqlite` | Local library; created on first run and ignored by Git |

`NARAD_DATA_DIR` overrides the data folder. `NARAD_PORT` overrides the API port. Set `VITE_API_TARGET` when using a different API address in development.

Seeding adds missing sample IDs without overwriting existing analyses. To back up a live database, use SQLite backup facilities; alternatively stop the server before copying the data folder. Export individual lessons from the reader.

## Prepared lesson format

Export a sample from the reader for a complete example. Each document has `version: 1`, a unique analysis `id`, metadata, original `sources`, `assets`, and one or more prepared `modes`.

Each mode contains ordered sections. Sections contain blocks with stable IDs, display content, `spokenText`, an `origin` (`source` or `teaching`), and source references. Block kinds: `text`, `equation`, `figure`, `callout`, and `dialogue`.

Use a distinct analysis ID to import an edited copy. Imports never overwrite existing lessons.

Source-derived blocks require valid source/locator references. Equations retain exact LaTeX alongside explanatory Markdown and narration. Figures refer to assets with captions, alt text, and provenance.

For portable imported images, use embedded PNG/JPEG/WebP data URLs. Paths under `/assets/` refer to files already bundled with this installation. Sample exports retain bundled references; they are not general-purpose asset archives. Missing bundled files are rejected. The prepared-lesson file picker limits imports to 12 MB; the API request limit is 32 MB to accommodate mixed image intake.

Raw HTML is not rendered. In prepared lessons, Markdown image syntax displays an explanatory placeholder: use explicit figure blocks to preserve caption, source, and narration associations.

Structural validation does not certify factual completeness or accuracy. Full lesson coverage checking and agent review remain in Part 2.

## Source intake

The composer accepts up to 8 public HTTP(S) article links and 6 PNG/JPEG/WebP uploads (5 MB each, bounded aggregate size). Text-only ideas are saved without pretending research or lesson generation has occurred. Source collections are separate from completed analyses.

Article capture stores the original HTML snapshot and asset bytes in SQLite. It extracts the first article element, then main/body as fallbacks. Images and inline SVGs remain in source order; previews retain figures, mathematics, tables, headings, and prose. The source preview displays a visual inventory, enlarges figures, and offers original visual downloads. Original GIF/AVIF files are retained; TIFF uses a first-page PNG preview with an explicit warning. SVGs are screened and rasterized for display; original SVG downloads use attachment disposition and a restrictive CSP.

MathJax TeX scripts and HTML superscripts/subscripts have explicit conversion rules. Tables without header cells retain all rows; merged-cell tables are flagged because the Markdown preview flattens their grouping. Missing visuals leave visible placeholders and capture warnings. Retry incomplete sources after a download failure; refresh a successful collection to capture its current article contents. Refresh replaces that collection’s captured article snapshot.

Capture is static, not a browser engine. JavaScript-only content, canvas charts, embedded media, MathML, authentication, unusual markup, and complex SVG styling may need additional images or manual source review. PDFs and other documents are not supported yet. A successful inventory is not a factual-completeness certification. No claims in captured articles are independently verified by this checkpoint.

Downloads are limited to public addresses and standard HTTP(S) ports, rechecked on redirects and pinned to validated DNS results. Limits: 20 MB per remote file, 80 MB downloaded material per article, 200 visuals per article, four concurrent visual operations, one capture request at a time. Sources are untrusted input; their scripts and raw HTML are never executed.

The supplied Jalapeño article was captured and checked in the browser: 39 figures, 35 inline SVG equations/diagrams, and 7 tables; all 74 displayed visuals decoded successfully. This is a local source collection, not a bundled sample or generated lesson.

## Verification

    npm test
    npm run test:e2e
    npm run build

Browser tests use installed Google Chrome, start isolated servers on ports 4319/5179, and create a temporary database. They do not modify the live library.

The KaTeX dependency override aligns transitive copies with the patched direct dependency. The build emits a non-blocking bundle-size advisory because math/Markdown rendering is included in the initial bundle. Code splitting can be considered when the app grows.

## Product decisions and next steps

See [the PRD](docs/superpowers/specs/2026-10-19-narad-design.md), [Part 1 plan](docs/superpowers/plans/2026-10-19-narad-part-1.md), and [progress](docs/progress.md).

1. **Library and reader** — completed.
2. **Research and generation** — Part 2A source intake is the current feedback checkpoint; agent-generated lessons and minimal session controls follow.
3. **Local narration** — provisional Qwen3-TTS 1.7B CustomVoice through MLX Audio, subject to listening/latency tests.
4. **Interactive tutor** — contextual questions, illustrated detours, and familiarity adaptations.

User feedback is required before advancing to the next checkpoint.
