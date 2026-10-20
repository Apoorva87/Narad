# Narad

*A voice for your everyday learning*

A local learning workspace for faithful explanations, illustrated walkthroughs, and interactive spoken tutoring.

## Current checkpoint: Part 4 of 4 — contextual tutor

Implemented:
- Veena-inspired Narad logo, drawing on Narada’s musical association.
- Add a lesson from text ideas, multiple article links, uploaded/dropped/pasted images, or a mixture.
- Persistent source collections with ordered article previews, captured visuals, missing-content warnings, and retry/refresh.
- Library list of lessons and saved sources, newest first, with search, inline rename, and permanent delete. Deleting removes database rows, unused saved images, and preparation drafts from this Mac; deleted samples are not restored.
- Settings page (gear at the top right of the library, or `#settings`): edit every preparation prompt (shared principles, level descriptions, brief summary, walkthrough, dialogue, figures, research, section writing, revision, review), agent and model, review rounds, chunk sizes, time limits, research/capture limits, default level, dialogue speaker names, default voices, speed, and voice speaking styles. Prompts are templates with `{{slots}}`; required slots are enforced. Only changed values are stored, each field resets to its default, and each preparation saves the settings it used as `settings.json` beside its drafts. Changes apply to future preparations only.
- Choose a learner level (foundational, some background, advanced) when adding sources or before preparing; the agents write for that level.
- Distinct quick-summary, detailed-walkthrough, and tutor-dialogue reading modes.
- Markdown, mathematics, tables, saved diagrams, captions, and source snapshots.
- Explicitly marked teaching additions.
- Passage/section navigation and saved reading positions per analysis and mode.
- Validated lesson JSON import/export; exports embed saved source images so they import on another Mac. Malformed lessons and duplicate IDs are rejected.
- Responsive desktop/mobile reader, keyboard-accessible controls and dialogs.
- Prepare all three modes using installed Codex or Claude, with per-section review and bounded correction.
- App-owned live session count, progress, stop/retry, retained drafts and job history.
- Topic research, captured article collections, and source-image explanations through the same preparation flow.
- On-demand local Qwen3-TTS narration, separate narrator/host/tutor voices, meaning-aware pacing around the selected speed, pause/resume/stop, and automatic passage highlighting and scrolling. Article audio is never saved to disk.
- Presentation mode: full-screen narration that holds the latest figure on screen until the next one, with an optional transcript. Swipe and tap gestures on touch screens; lock-screen and headphone controls via Media Session. The lock screen shows the current slide as artwork (converted to PNG, which iOS requires) and the sentence being spoken as the title.
- Keyboard shortcuts in the reader (press `?`): Space/K play-pause, ←/→ or J/L passages, Shift+←/→ sections, 1–3 modes, −/+ speed, P present, T transcript, A ask the tutor while presenting.
- Passage-specific tutor threads: type a question or dictate an editable transcript, answer from the saved lesson or ask Codex/Claude to research further, and retain the discussion under `Replies` beneath that exact passage.
- Structured tutor answers with Markdown, equations, citations, saved source figures, and constrained teaching diagrams/plots. Expanded replies participate in narration; collapsed replies are skipped. An interrupted live answer stops afterward until you choose `Continue lesson`.

Two samples use original teaching notes about Bayesian reasoning and gradient descent. They demonstrate the reader; they are not output from a live research pipeline.

**Not implemented yet:** PDF/document ingestion and adapting an existing lesson to a new familiarity level. Tutor dialogue remains a saved host–expert script; contextual threads provide the live tutor conversation.

## Run

Requires Node.js 24 or newer; verified on Node 25.8.1.

For a new checkout, the setup script installs locked JavaScript dependencies and verifies a production build:

    ./setup.sh

Add `--with-speech` to also create the Python environment and download the local voice model (about 2.9 GB):

    ./setup.sh --with-speech

The equivalent manual development setup is:

    npm install
    npm run dev

Open http://127.0.0.1:5178/. The API runs on port 4318. Both bind to loopback.

For a production build:

    npm run build
    npm start

Then open http://127.0.0.1:4318/. Stop either launch command with Ctrl+C.

### Private access from an iPhone with Tailscale

Keep Narad bound to loopback and let [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) provide the private HTTPS endpoint. Install and sign in to Tailscale on the Mac and iPhone, then choose the exact HTTPS name for this Mac and start Narad with it:

    npm run build
    NARAD_WEB_ORIGIN=https://<machine>.<tailnet>.ts.net npm start

In a second terminal, publish the loopback production server to this tailnet only:

    tailscale serve --bg 4318
    tailscale serve status

Open the HTTPS URL printed by Tailscale in mobile Safari. Do not use `tailscale funnel`; Narad is intended to remain private to the tailnet. `tailscale serve reset` removes the route. Tailscale Serve persists its route, but the Narad process must be running: restart `npm start` after closing its terminal or rebooting the Mac. The speech worker itself starts on the first Listen, stays warm while Narad runs, and automatically starts again after a worker failure. The voice pill shown throughout the app distinguishes an available cold worker, startup, ready/generating, model errors, and an unreachable host.

For an app-like window, use Safari’s **Add to Home Screen**. After pressing Listen once, Narad supplies lesson metadata and play/pause/previous/next actions to the system media controls. It keeps the current audio plus three following short segments in temporary memory, which improves transitions when Safari is backgrounded or the phone locks. iOS may suspend JavaScript or network work after that bounded buffer runs out, so uninterrupted playback of an entire long lesson is not guaranteed. Validate on the actual iPhone by starting a walkthrough, locking the phone, letting at least four segments advance, and trying the lock-screen controls. No audio is stored on the phone or Mac by this feature.

Reading saved lessons requires no agent credentials or TTS model. Preparing a new lesson requires an installed, signed-in Codex or Claude CLI and uses that account’s remote model service. Speech runs locally after the one-time setup below. Fonts and demonstration figures are bundled; saved lessons do not depend on a CDN.

## Local speech

On an Apple Silicon Mac with GPU access, install [uv](https://docs.astral.sh/uv/) and run once:

    npm run speech:setup

This creates `speech/.venv`, installs the locked Python 3.12 / MLX Audio 0.6.0 environment, and downloads the pinned Qwen3-TTS 1.7B CustomVoice 8-bit model into `data/models/qwen3-tts` (about 2.9 GB). Inference uses local files with Hugging Face offline mode; lesson text is not sent to a speech service. Setup needs internet access. Run the normal `npm run dev` or `npm start` in a Mac session with Metal GPU access; a restricted coding sandbox can prevent Metal from starting.

Open a lesson and select **Listen**. The local model loads on the first request and remains warm until the API stops. A small Python child belongs to the API and exits when its input pipe closes; it is not an agent session. Pause resumes the current audio position. Stop, navigation to another passage, or a voice change restarts from that passage when played again. Mode changes and leaving the reader stop audio. The bookmark beside a passage selects where to listen; section controls work on mobile too.

**Voice settings** select the narrator and, in dialogue mode, separate host and tutor voices. Ryan is the default narrator/tutor and Aiden the host; Vivian and Serena are also available. Speed ranges from 0.5× to 2× and remains the learner's baseline. Narad makes restrained sentence-level adjustments around it: definitions, quantities, formulas, causal explanations, and unusually dense sentences slow to 0.90× of the baseline, while simple transitions rise to 1.06×. The final audio rate remains within 0.5×–2× and preserves pitch. Voice/rate choices are saved in this browser. Reading position is saved per lesson/mode; refresh resumes at the passage, not at an exact audio timestamp.

Narration uses saved `spokenText`, including natural readings of formulas and values. Long passages are split into deterministic sentence-level segments shared by the browser and speech server; adjacent segments with the same pace may be combined to reduce generation gaps. Three-segment look-ahead keeps the next parts ready. Highlighting tracks the passage, not individual words. Audio is buffered per short text segment rather than streamed token by token. Playback automatically brings the current text/figure into view on start and resume. Long passages scroll progressively using segment position and elapsed audio; this is approximate visual progress, not word-level alignment. The readable area excludes the player, and loaded-image/layout changes recalculate it. Pausing stops scrolling. There may be brief gaps if a following segment is not ready. No synthesized audio starts without pressing Listen; browser autoplay restrictions surface a retry prompt.

The host TTS worker stays warm and receives text chunks as you listen. Audio is returned directly with `Cache-Control: no-store`; there is no article audio directory or saved-audio endpoint. The browser holds only its current short chunk and up to three look-ahead chunks in temporary memory. Finished, skipped and cancelled audio is released. Pause retains the current chunk to resume at the same point; speed changes use that same in-memory audio. Revisiting a passage generates it again. Saved lessons retain their text and visual assets. The model weights remain installed under project `data/models` even when the library data directory is overridden.

Measured on this Mac with the same 222-character sample: Ryan generated 19.2 seconds of audio in 18.7 seconds including first model load; Aiden generated 13.84 seconds in 3.0 seconds with the model warm. These are two observations, not a latency guarantee. The user approved the voices. Run `node --import tsx scripts/speech-check.ts` to measure generation again without saving audio files. Source: [MLX Audio Qwen3-TTS API and preset voices](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/tts/models/qwen3_tts/README.md).

## Data and project structure

| Location | Responsibility |
| --- | --- |
| `shared/lesson.ts` | Versioned lesson validation and shared types |
| `shared/navigation.ts` | Passage navigation across section boundaries |
| `shared/speech.ts` | Shared narration chunks, requests, and voice preferences |
| `shared/tutor.ts` | Validated contextual-question and safe answer-component contract |
| `server/speech.ts` | Saved-passage validation and on-demand synthesis queue |
| `server/speech-worker.ts`, `speech/worker.py` | Resident local MLX model, JSON-lines protocol, and cancellation |
| `src/lib/narration.ts` | Playback ownership, pause/resume, prefetch, and stale-response protection |
| `content/samples.json` | Original sample source snapshots and all three mode scripts |
| `public/assets/` | Saved demonstration diagrams |
| `shared/sources.ts` | Source intake and visual inventory contract |
| `server/preparation.ts` | One owned preparation job, research, section authoring/review, and publication |
| `server/agent-runner.ts` | Structured Codex/Claude CLI calls, cancellation and bounded output |
| `server/tutor.ts`, `server/tutor-store.ts` | Contextual agent execution, progress, cancellation, and persistent threads |
| `server/cli-host.mjs` | Child helper tied to server IPC lifetime; cleans up its own process group |
| `server/generation-content.ts` | Multi-source segmentation, coverage checks, and lesson assembly |
| `server/lesson-preparation.ts` | Coverage-checked compilation of authored teaching into three reading modes |
| `scripts/publish-prepared-lesson.ts` | Validate a local authoring manifest, write coverage/artifact files, and optionally save through the API |
| `server/capture.ts` | Ordered article extraction and safe SVG previews |
| `server/download.ts` | Bounded public-network downloads with pinned DNS and redirect checks |
| `server/store.ts` | SQLite app state (settings, reading positions) over the folder library |
| `server/library-fs.ts`, `server/migrate.ts` | Per-item folders under `data/library`, and the one-time move out of SQLite |
| `server/app.ts` | Library, import, progress, source capture/retry, and saved asset API |
| `src/components/` | Reader, library, source view, and import UI |
| `data/library/` | One folder per item: sources, media, lesson, credits, preparation progress. Ignored by Git |
| `data/narad.sqlite` | App state only: settings and reading positions |
| `data/tutor.sqlite` | Passage-attached question and answer threads |

`NARAD_DATA_DIR` overrides the data folder. `NARAD_PORT` overrides the API port. Set `VITE_API_TARGET` when using a different API address in development.

### Browsing and editing your library

Every item lives in its own folder under `data/library/`. The folder name is the item's identity, and the routes are `#lesson/<folder>` and `#sources/<folder>`:

```
data/library/
  interpretability/
    item.json              title, createdAt, level, status, legacyIds
    lesson.json            the finished lesson (absent until prepared); hand-editable
    lesson.md              readable export of the walkthrough, regenerated on publish
    CREDITS.md             regenerated whenever sources or the lesson change
    sources/
      notes.md             your notes and request
      01-<slug>.md         captured article text
      01-<slug>.html       original page snapshot
      01-<slug>.json       capture metadata: URL, warnings, inventory, assets with credits
    media/                 displayed images (SVGs kept as originals too) and video poster images
    preparation/
      progress.json        run state, per-section state, per-call records, token usage
      settings.json        settings used by the latest attempt
      sections/<task>.json each approved section
      calls/NNN-<step>-<task>.prompt.md / .result.json / .log
      runs/<timestamp>/    earlier published versions and abandoned attempts
```

You can read these files in Finder, copy a folder to share it, or edit `lesson.json` and the Markdown by hand; Narad re-reads folders on each request. A file that no longer parses marks only that item as broken and names the problem. The preparation panel has **Open folder** and a copyable path. Renaming an item in the app renames its folder; renaming it in Finder makes it a new item (reading positions reset). Deleting an item removes its folder. Old lesson and source-collection IDs keep working through `legacyIds`. SQLite keeps only settings, deleted-sample markers and reading positions.

Seeding adds missing samples as folders without overwriting existing ones. Back up by copying `data/` while the server is stopped; export individual lessons from the reader.

### One-time migration

On the first start after upgrading, Narad copies `narad.sqlite` to `data/backups/narad-<timestamp>.sqlite`, writes each lesson and source collection as a folder, moves old `data/preparations/<job>/` files into the matching item's `preparation/runs/legacy-<job>/`, and only then empties the old content tables. If any folder fails to validate, the database is left untouched, the failure is logged, and migration is retried on the next start. Runs that were interrupted before publishing are salvaged: approved sections whose source text still matches are imported, so **Continue** resumes where the old run stopped.

## Prepared lesson format

Export a sample from the reader for a complete example. Each document has `version: 1`, a unique analysis `id`, metadata, original `sources`, `assets`, and one or more prepared `modes`.

Each mode contains ordered sections. Sections contain blocks with stable IDs, display content, `spokenText`, an `origin` (`source` or `teaching`), and source references. Block kinds: `text`, `equation`, `figure`, `callout`, and `dialogue`.

Use a distinct analysis ID to import an edited copy. Imports never overwrite existing lessons.

Source-derived blocks require valid source/locator references. Equations retain exact LaTeX alongside explanatory Markdown and narration. Figures refer to assets with captions, alt text, and provenance.

For portable imported images, use embedded PNG/JPEG/WebP data URLs. Paths under `/assets/` refer to files already bundled with this installation. Sample exports retain bundled references; they are not general-purpose asset archives. Captured assets use `/api/source-assets/<hash>` references. Exported prepared lessons require their linked source collection and saved asset bytes in the destination installation; JSON export alone is not a portable backup. Missing bundled files are rejected. The prepared-lesson file picker limits imports to 12 MB; the API request limit is 32 MB to accommodate mixed image intake.

Raw HTML is not rendered. Markdown images resolve only through validated lesson assets. Use explicit figure blocks to preserve caption, source, and narration associations.

Structural validation does not certify factual completeness or accuracy. The preparation compiler checks source-unit and visual coverage; its publishing script also audits numeric tokens in source paragraphs. These checks complement content review and do not prove semantic equivalence.

## Credits, videos and capture warnings

Capture records, for each image and video, the page title and URL, the media URL, its caption, a credit line found next to it (figcaption, cite, "photo by", "courtesy", ©) and a licence only when the page declares one; nothing is guessed. `CREDITS.md` in each item folder groups these by source page. The reader shows a credit line under each source figure and lists every credit in the Sources dialog; presentation mode shows it under the held figure, and lesson export carries it.

Videos (`<video>`, YouTube, Vimeo) are never downloaded. The reader streams them from the source (YouTube through `youtube-nocookie.com`) with a "Watch at the source" link that remains if the embed fails or you are offline. The poster image is saved. Starting a video pauses narration.

Capture warnings come in two kinds. Blocking ones (article text unreadable, an image or poster failed to save) stop preparation until a refresh fixes them. Informational ones (interactive pieces, canvases, other iframes, MathML, merged table cells, TIFF previews) never block: each becomes a "Not captured" note in the lesson at that place, with a link to the original, and is listed in the source view.

## Source intake

The composer accepts up to 8 public HTTP(S) article links and 6 PNG/JPEG/WebP uploads (5 MB each, bounded aggregate size). Text-only ideas are saved without pretending research or lesson generation has occurred. Source collections are separate from completed analyses.

Article capture stores the original HTML snapshot and asset bytes in SQLite. It extracts the first article element, then main/body as fallbacks. Images and inline SVGs remain in source order; previews retain figures, mathematics, tables, headings, and prose. The source preview displays a visual inventory, enlarges figures, and offers original visual downloads. Original GIF/AVIF files are retained; TIFF uses a first-page PNG preview with an explicit warning. SVGs are screened and rasterized for display; original SVG downloads use attachment disposition and a restrictive CSP.

MathJax TeX scripts and HTML superscripts/subscripts have explicit conversion rules. Tables without header cells retain all rows; merged-cell tables are flagged because the Markdown preview flattens their grouping. Missing visuals leave visible placeholders and capture warnings. Retry incomplete sources after a download failure; refresh a successful collection to capture its current article contents. Refresh replaces that collection’s captured article snapshot.

Capture is static, not a browser engine. JavaScript-only content, canvas charts, embedded media, MathML, authentication, unusual markup, and complex SVG styling may need additional images or manual source review. PDFs and other documents are not supported yet. A successful inventory is not a factual-completeness certification. No claims in captured articles are independently verified by this checkpoint.

Downloads are limited to public addresses and standard HTTP(S) ports, rechecked on redirects and pinned to validated DNS results. Limits: 20 MB per remote file, 80 MB downloaded material per article, 200 visuals per article, four concurrent visual operations, one capture request at a time. Sources are untrusted input; their scripts and raw HTML are never executed.

The supplied Jalapeño article was captured and checked in the browser: 39 figures, 35 inline SVG equations/diagrams, and 7 tables; all 74 displayed visuals decoded successfully. The local library now also contains a separately authored quick summary, a 29-section detailed walkthrough, and a 29-section host–expert dialogue. Both detailed modes retain all 74 visuals and 7 tables, with explanatory notes and spoken text. This lesson is local data, not a bundled sample.

## Verification

    npm test
    npm run test:e2e
    npm run build

Browser tests use installed Google Chrome, start isolated servers on ports 4319/5179, and create a temporary database. They do not modify the live library.

The KaTeX dependency override aligns transitive copies with the patched direct dependency. The build emits a non-blocking bundle-size advisory because math/Markdown rendering is included in the initial bundle. Code splitting can be considered when the app grows.

## Product decisions and next steps

See [the PRD](docs/superpowers/specs/2026-10-19-narad-design.md), [Part 1 plan](docs/superpowers/plans/2026-10-19-narad-part-1.md), and [progress](docs/progress.md).

1. **Library and reader** — completed.
2. **Research and generation** — source capture, automatic preparation with Codex/Claude, per-section review, and minimal session controls are available. PDF ingestion and supplementary generated diagrams remain unfinished.
3. **Local narration** — implemented with Qwen3-TTS 1.7B CustomVoice through MLX Audio; voices approved, on-demand playback without saved article audio.
4. **Interactive tutor** — contextual typed/dictated questions, researched answers, illustrated detours, persistent threads, and spoken replies are implemented. Familiarity adaptations remain next.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, persistence, trust rules, and playback ownership.

## Ask the contextual tutor

In presentation mode, the **Ask tutor** button (or `A`) opens the same conversation in a panel over the slide: a bottom sheet on phones, a side panel on desktop. The panel stays on the passage it was opened on while narration moves on; **Back to current passage** switches it. Swiping inside the panel never changes the slide.

Open any lesson passage and choose **Ask tutor**. Narad pauses narration, keeps its position, and shows a composer beneath that passage. Dictation uses the browser's speech-recognition capability and always lands in the editable text box before submission; when recognition is unavailable, type or use the operating system's keyboard dictation.

**Explain this lesson** restricts the selected Codex/Claude session to the passage, its neighbors, referenced saved source text and figures, lesson familiarity, and earlier turns. **Research further** explicitly enables web search and requires titled URL citations. The question is saved before the agent starts. Reading, composing, failure, cancellation, and completion stages remain visible in the thread.

The first answer requested while lesson narration was playing is spoken through the local TTS server, then stops. Choose **Continue lesson** to resume the paused lesson audio. During ordinary playback, only expanded reply threads are read; collapse `Replies` to bypass them. Tutor WAV data is ephemeral under the same policy as lesson narration.

## Preparing the Jalapeño lesson

The ignored local folder `data/jalapeno-authoring/` holds the source-unit inventory, three authored content files, summary, manifest, compiled `lesson.json`, and `coverage.json`. The published copy lives in SQLite.

    node --import tsx scripts/publish-prepared-lesson.ts data/jalapeno-authoring/manifest.json

Add `--publish` to save a new lesson after reviewing its content and coverage. Existing IDs are rejected. `NARAD_API_URL` overrides the default local API. Authoring files must already contain reviewed teaching content; the script does not launch a model or generate prose.

## Prepare a lesson with an agent

Save a source collection, then choose **Codex** or **Claude** and **Prepare lesson**. Preparation continues while you read elsewhere. The **Agents** button shows real app-owned CLI sessions and recent jobs; it does not enumerate or stop unrelated terminal sessions. One preparation runs at a time. Completed jobs close their child processes automatically.

Install/sign in with the provider's CLI before starting Narad. Availability means the executable was found, not that account authentication has been verified. `NARAD_CODEX_BIN` and `NARAD_CLAUDE_BIN` can specify executable paths. The app uses the CLI's default model with project customizations disabled for the preparation subprocess. It never uses permission-bypass flags or interpolates source content into shell commands. Built-in file/network tools are restricted to the preparation task; source documents are treated as untrusted data.

For a topic-only input, the agent searches for up to four source pages, which Narad captures before writing. Images are passed to the model as visual inputs. Capture warnings block preparation until resolved. Sections are split into bounded groups without dropping source units; an individual paragraph/table over 24,000 characters requires splitting the source. Display explanations, spoken scripts, visual notes, individual source summaries and synthesis are saved. A separate model call reviews each teaching group against its source and images; one correction attempt is allowed. These checks reduce omissions but do not certify truth or perfect visual interpretation.

Progress lives in the item's `preparation/` folder (see above): each approved section is saved as its own file, and every agent call leaves its prompt, result and log under `calls/`. Nothing resumes by itself. A run that was stopped, failed or interrupted by a server restart (it is marked honestly after restart) shows **Continue**, which reuses every finished section whose source text is unchanged and writes only the rest, using your current settings. **Start over** moves finished sections into `runs/` and starts fresh; changing the learner level also starts over, after asking. A single failed agent call is retried once before the section is marked failed. Sections are written two at a time by default (Settings → Preparation → **Sections at once**, 1–4); only one item is prepared at a time. The panel lists each section's state and duration, and shows tokens used by the run (input, output, cached, and cost when the agent reports it; Codex reports tokens only), summed over every call including retries. Graceful shutdown stops active jobs; the CLI helper also watches the server IPC connection and terminates its own process group if the server disappears. A CLI call is bounded to 12 minutes and 12 MB of captured output. Long sources involve many calls and can take substantial time.

Preparing a new version archives the earlier `lesson.json` under `preparation/runs/` and publishes the new one in place.

The repository skill is [.agents/skills/narad-prepare/SKILL.md](.agents/skills/narad-prepare/SKILL.md). Its CLI uses the same routes as the UI:

    node --import tsx scripts/narad.ts add input.json
    node --import tsx scripts/narad.ts prepare <bundle-id> codex
    node --import tsx scripts/narad.ts status
    node --import tsx scripts/narad.ts stop <job-id>

`input.json` uses the source input shape `{ "title": "...", "text": "ideas or links", "images": [] }`. `NARAD_API_URL` overrides the default local API. The server accepts its own HTTP origin and the default local Vite origin on port 5178; set `NARAD_WEB_ORIGIN` to one exact HTTPS reverse-proxy origin, or to a loopback HTTP origin when changing development ports.

Provider integration references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude programmatic use](https://code.claude.com/docs/en/headless). Claude's CLI schema validator uses JSON Schema Draft 7; both provider requests use that dialect.
