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


## Part 2A — feedback incorporated

User requested a mythology-inspired Narad mark, mixed images/text/links as lesson inputs, and preservation of all source plots and figures. This authorizes the source-intake portion of Part 2.

- Replaced the lettermark with a veena-inspired SVG logo and favicon.
- Added mixed-input composer while retaining prepared-lesson JSON import.
- Added persisted source collections, original snapshots, content-addressed image bytes, ordered preview, visual inventory, enlargement, original downloads, and retry/refresh.
- Source collections are explicitly labeled as captured material, not generated lessons. Agent generation, OCR, PDF ingestion, additional tutor diagrams, narration, and interactive tutoring remain subsequent work.
- Independent review caught headerless tables disappearing, superscript/subscript and MathJax loss, transformed originals, and AVIF metadata naming. Added regression coverage and corrected each.
- Browser inspection found two inline equations inside code-styled prose: both now render as equations. Browser test also caught invalid nested modal markup; corrected with a portal and console-error regression assertion.
- Actual supplied Jalapeño article: 39 figures + 35 inline SVG equations/diagrams = 74 saved and displayed visuals, all decoded successfully; 7 tables. Desktop and 390px mobile preview fit the viewport.
- Known boundaries: static HTML extraction; unsupported embedded/interactive content and merged tables need source review. Captured content is not independently fact-checked. Original snapshots remain local, not committed.

- Final verification: 33 unit/integration tests and 9 browser tests pass; TypeScript and production build pass. Production dependency audit: zero vulnerabilities. Existing non-blocking math/Markdown bundle-size advisory remains.
- Screenshots: artifacts/add-lesson.png, source-preview.png, preserved-figure.png, preserved-figure-mobile.png, library-with-sources.png.

**Checkpoint:** show Part 2A logo/intake/source preview for feedback before continuing agent-generated tutoring.

## Part 2 — Jalapeño tutoring correction

User correctly identified that the source preview did not deliver the agreed learning modes. Prepared and saved `jalapeno-inference-chip` with a 255-word summary, 29-section walkthrough, and distinct 29-section host–expert dialogue. All 202 source units are accounted for, including 74 visuals and 7 exact source tables in both detailed modes. Three content authors inspected and explained visuals; attributed claims and estimates remain qualified.

Added a coverage-checked compiler and local publishing script, validated captured-asset references, and source/lesson association. The library shows one prepared lesson in place of a duplicate source card; the original source view links to its lesson. Prepared lessons default to summary until a reading position is saved. The original snapshot remains accessible from the reader.

Independent review found a headingless-preamble omission in the compiler; a failing regression reproduced it and the parser now retains the first paragraph. Export portability is documented: JSON references local source collections and assets and is not a self-contained backup.

Actual browser inspection: all source and walkthrough images decoded, no KaTeX rendering errors, all three modes present, mobile fits 390px viewport. Screenshots: `artifacts/jalapeno-summary.png`, `jalapeno-walkthrough.png`, `jalapeno-dialogue.png`, `jalapeno-mobile.png`.

Still unfinished: automatic generation from new inputs, agent session controls, narration, live questions, and familiarity adaptation. This checkpoint supplies the actual example lesson and its reusable compilation path.

Final verification for this correction: 39 unit/integration tests and 11 browser tests passed; TypeScript and production build passed. The existing non-blocking bundle-size advisory remains.


## Part 2 — automatic agent preparation

The user authorized the next checkpoint after reviewing Jalapeño's actual learning modes. Implemented the remaining web-driven preparation path, retaining the existing Node/React/SQLite architecture and avoiding a supervisor service.

- Added source-scoped teaching tasks, multiple-source assembly, uploaded-image preservation, exact tables, required unit/visual coverage, numeric-token checks, and individual-resource summaries plus synthesis.
- Added structured noninteractive Codex and Claude adapters with restricted tools, retained prompts/logs/outputs, bounded calls, and a separate content-review pass with one correction attempt.
- The Express process owns one job at a time. SQLite persists job state; an IPC-bound child helper owns the CLI process group. The web UI displays actual live child count, progress, and stop/retry. Existing lessons remain immutable.
- Topic-only inputs discover up to four sources, then use the existing safe capture path. Capture failures remain visible and block publication.
- Repository-local `.agents/skills/narad-prepare/SKILL.md` and `scripts/narad.ts` use the same API as the web UI. No global skill/config changes were made.
- Independent review found SIGTERM-resistant child leakage, stale capture UI after failed discovery, permissive summary validation, and overly broad local origins. Reproduced each with regression tests, fixed each, and the reviewer confirmed closure.
- Additional image-only regression ensures dialogue includes an expert response. Live Claude testing caught schema-dialect rejection; requests now use Draft 7 rather than Zod's default 2020-12.
- Real Codex run completed the captured MDN latency article, reviewed three sections, published all three modes, and returned session count to zero. The lesson and logs remain local for inspection.

Rulings: use existing checkout to preserve the running app and prior uncommitted checkpoint. Retry means a fresh preparation, not recovery orchestration. No automatic PDF extraction or supplementary diagram creation in this checkpoint. Source completeness checks complement model review; they do not prove factual correctness. Speech and interactive tutoring remain the next two feedback checkpoints.

Claude's installed CLI accepted Draft 7 but its account returned “OAuth session expired and could not be refreshed.” This is an external authentication blocker, not a completed Claude generation test. Error handling now extracts provider JSON diagnostics from stdout and tells the user to sign in again. Codex is used for the live image check.

Live image review rejected a monologue presented as dialogue. Added explicit per-visual host/expert turns to the authoring contract and compiler; the figure remains in place and the dialogue uses independently written spoken exchanges. Existing prepared lessons remain compatible. A regression verifies visual dialogue turns survive compilation. Stopped the older image check and regenerated with this correction.

The regenerated Codex image job completed successfully (`94d8e3b8-ece1-4ab9-ada5-81bb02957dbd`). Its independent review approved the content. All three modes are saved; the dialogue includes ten visual-specific host/expert turns, the original local image, and rendered equations. The cancelled predecessor published no lesson. Session count returned to zero. Browser inspection found no console or KaTeX errors, and the lesson fits a 390px viewport. Screenshots: `artifacts/generated-image-dialogue.png` and `generated-image-dialogue-mobile.png`.

Final verification: 61 unit/integration tests and 13 browser tests passed; TypeScript and production build passed. The existing non-blocking bundle-size advisory remains. Real Codex article and image generation were exercised; Claude generation remains blocked by expired authentication, and topic-only source discovery has not had a live provider smoke test. Research outputs now reject plain labels where HTTP(S) links are required.

**Checkpoint:** automatic preparation is ready for user feedback. Local narration remains Part 3; interactive questions and familiarity adaptation remain Part 4.

## Part 3 — local narration

User approved Part 2 and requested the next checkpoint. Implemented local Qwen3-TTS 1.7B CustomVoice (8-bit) through pinned MLX Audio 0.6.0, using the approved provisional model choice. Installed Python environment and downloaded a pinned model revision (2.9 GB) into project-local ignored data. No cloud speech requests are used.

- Express owns one lazy resident Python worker with JSON-lines requests. Saved block references determine the spoken text; bounded sentence chunks preserve content order. Inference is serialized, cancellation is checked between generated audio chunks, and the worker exits when its parent input closes.
- Audio is cached by model revision, voice, style and text. Only valid complete WAV files are published. Shutdown rejects queued work and discards late results; corrupt cached files regenerate.
- Reader now supports Listen, Pause/Resume, Stop, 0.5×–2× pitch-preserving speed, narrator/host/tutor voice settings, existing passage and section navigation, and automatic passage highlighting/scrolling. Voice/rate preferences persist in browser storage. A voice change restarts the passage; refresh restores passage position rather than exact audio time.
- A single audio controller invalidates stale requests on pause during loading, navigation, voice changes, mode changes and unmount. One-chunk prefetch reduces gaps. Display math, source images and all lesson content remain unchanged.
- Independent review found queued synthesis after worker close and permanently poisoned corrupt cache entries. Both were reproduced with failing tests and fixed. Browser testing also caught delayed audio stopping on the reader back button; the click now stops audio immediately.

Real measurements from the same 222-character narration: Ryan produced 19.2 seconds of audio in 18.74 seconds including cold startup; Aiden produced 13.84 seconds in 3.00 seconds with a warm model. Voice comparison files are `artifacts/speech/ryan.wav` and `aiden.wav`. Actual Jalapeño image-lesson dialogue played in the browser and advanced to the tutor passage. A real aborted request followed by a fresh request succeeded in 2.94 seconds, producing 13.2 seconds of audio and leaving the worker ready. A repeat cache request took 2 ms (one observation, not a guarantee).

Verification: **73 unit/integration tests, 16 browser tests, TypeScript and production build pass**. Desktop and 390px mobile controls inspected; mobile fits without overflow and retains section navigation. Screenshots: `artifacts/speech-desktop.png`, `speech-mobile.png`. Existing non-blocking bundle-size advisory remains.

Boundaries: buffering per short text chunk, not token-level browser streaming; passage rather than word timing; possible gaps while uncached chunks generate; model stays resident until API exit; cache has no automatic eviction. Subjective voice quality awaits user listening feedback. Setup and measurements documented in README. Part 4 (live questions, attached detours, familiarity changes) remains unimplemented.

**Checkpoint:** Part 3 ready for listening feedback. Do not begin Part 4 until the user requests it.

## Part 3 feedback — generate narration as needed, without disk audio

The user approved the voices and requested a resident host TTS server receiving text/paragraphs as playback advances, without saved article WAVs. This supersedes the audio-cache decision above.

- Removed all speech-service filesystem/cache code and the saved-audio GET endpoint. Each POST returns generated WAV bytes directly with `Cache-Control: no-store`; the model worker stays warm as before.
- The browser uses temporary object URLs for the current short chunk and one look-ahead chunk. Completion, stop, skipping, voice changes, errors, unmount and late cancelled responses release owned URLs. Pause retains the current chunk for exact resume. Revisited passages generate again.
- Removed 20 previously generated/cache/comparison WAV files, freeing 11.14 MiB. The benchmark script now measures without writing files. Model weights, saved teaching text and images remain installed/persisted.
- Added regressions for repeated on-demand inference without filesystem output, direct audio HTTP responses/no-store/removed endpoint, and temporary-audio ownership across pause/advance/cancel/unmount. Independent review found no material defects; removed its noted idle queue reference to the last server audio buffer.
- Verification: 75 unit/integration tests, 16 browser tests and production build passed. Real local dialogue audio played through the new direct-response path and paused successfully; no article WAV files were recreated.

Narration still uses short text chunks, not token-by-token browser audio streaming. This avoids saving a full article recording while retaining passage navigation and pitch-preserving speed. Part 4 remains pending.

## Part 3 feedback — follow text and images during playback

User requested automatic scrolling with narration. Found that the old scroll callback only fired when the saved passage ID changed: start/resume on the selected passage did not scroll, and multi-chunk long passages stayed at one position. Scrolling now follows actual audio progress independently of saved reading-position updates.

- Start/resume bring the active passage into the readable viewport; shorter text/figure blocks are centered above the sticky player.
- Tall passages advance using chunk order, spoken-text length and elapsed chunk audio. This is approximate visual progress, not word-level text alignment. The entire passage remains highlighted.
- Resize observers recalculate for loaded images and changed player height. Pause, stop, errors, mode changes and unmount cancel pending frames, observers and smooth scrolling. Reduced-motion preference uses instant positioning.
- Three geometry tests and browser regressions cover the initial selected passage, mobile diagram visibility, resume, long-passage movement and pause. Both native smooth scrolling and reduced-motion behavior were exercised.
- Independent review found no material issues. Verification: **78 unit/integration tests, 19 browser tests, TypeScript and production build pass**. No audio persistence was introduced.

## Part 3 feedback — meaning-aware narration pace

User requested tutor-like speed changes within a paragraph based on what deserves attention. Narration now creates deterministic sentence-level pacing segments from saved `spokenText`. Definitions, quantities, formulas, causal explanations and unusually dense sentences use a restrained `0.90×` focus multiplier; simple transitions use `1.06×`; other material stays at the selected baseline. The final rate remains clamped to the existing 0.5×–2× range with pitch preservation.

The learner's selector remains the baseline rather than being overridden: at a chosen 1.5×, a focus segment plays at 1.35×. Browser and server derive identical text boundaries, so on-demand requests, look-ahead generation, highlighting and automatic scrolling remain aligned. Consecutive segments with the same pace can still combine to limit synthesis gaps. No pacing markup appears in lesson text and no audio is saved.

Verification: **83 unit/integration tests and 19 browser tests pass; TypeScript and production build pass**. The browser coverage confirms baseline changes are immediately combined with the active semantic pace. Two older search tests were corrected to address the input's actual `searchbox` role.

## Part 4 — contextual tutor threads

User authorized passage-specific help as a persistent message board beneath the passage. Implemented typed questions and editable browser dictation, lesson-only or researched scope, Codex/Claude selection, coarse progress, cancellation, follow-ups, deletion, and persistent exact-anchor threads in `data/tutor.sqlite`.

Agents receive the active block, neighboring blocks, referenced saved source text and figures, familiarity, and prior turns. Lesson-only sessions have web search disabled. Research sessions enable search and must return a web citation. Responses use a strict component schema; Narad renders Markdown, equations, saved figures, node-edge teaching diagrams, and numeric plots with inspectable data instead of inserting agent HTML or SVG.

Expanded questions and answers join normal narration. Collapsed threads are skipped. Asking during playback pauses and preserves the lesson audio offset; the first completed answer is spoken separately and stops. `Continue lesson` returns to the preserved lesson player. Tutor speech is addressed by saved turn and chunk, so no arbitrary browser text reaches TTS and no WAV files are saved.

Added root `ARCHITECTURE.md`, executable `setup.sh`, a focused design/plan, API/store/context/playback tests, and a browser composer regression. A full browser run exposed an existing delayed-focus race in prompt slot insertion; the scheduled refocus now occurs only while that slot button still owns focus.

Final verification: **104 unit/integration tests and 30 browser tests pass; TypeScript and the production build pass**. The existing non-blocking initial-bundle size advisory remains. A real Codex lesson-only tutor request also completed successfully; its temporary thread was removed afterward.
