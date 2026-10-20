# Library Folders, Resumable Preparation, Credits and Streamed Videos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move library content into readable per-item folders, make preparation resumable from saved sections, record and show credits, stream videos from their source, and stop informational capture warnings from blocking preparation.

**Architecture:** A new `server/library.ts` owns folder layout, slugs, atomic writes and an mtime cache. `LessonStore` keeps its public method names but stores content in folders; SQLite keeps settings, deleted-sample markers and reading positions. A new `server/runner.ts` wraps every agent call (numbered files, one automatic retry, call records). `server/preparation.ts` becomes an orchestrator over `progress.json` with Continue / Start over. A one-time `server/migrate.ts` moves existing data, salvages legacy approved sections and renames tutor threads.

**Tech Stack:** Node ≥ 24, TypeScript, Express 5, `node:sqlite`, zod 4, cheerio/turndown, sharp, React 19, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-19-library-folders-design.md`

## Global Constraints

- Library root: `<data dir>/library/` (`NARAD_DATA_DIR`, default `data`).
- Slugs: lowercase ASCII, accents removed, `-` separated, ≤ 60 characters, `-2`, `-3`… on collision; fallback `untitled`.
- Item identity is the folder name; `lesson.id` and `lesson.sourceBundleId` equal the slug when read.
- Paths inside `lesson.json` are relative (`media/<file>`); served as `/api/library/<slug>/media/<file>`.
- Media route: filename must match `^[A-Za-z0-9._-]+$` and not start with `.`; headers `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`; SVG served with `Content-Disposition: attachment`.
- All writes atomic (temp file + rename) and serialized per item.
- No automatic resumption: startup turns `running` into `interrupted`; only the user's Continue resumes.
- One automatic retry per failed agent call; a second failure fails the section and the run.
- Sections at once: setting `preparation.sectionsAtOnce`, 1–4, default 2. One item prepared at a time.
- Videos are never downloaded. Embeds only from `www.youtube-nocookie.com` (YouTube rewritten to it), `player.vimeo.com`, or the original `https` file URL.
- `POST /api/library/:slug/reveal` only for loopback requests (`127.0.0.1`, `::1`, `localhost` host).
- Warnings are `{ kind: 'blocking' | 'info'; message: string; assetId?: string }`; only `blocking` stops preparation.
- **Repository state:** most of the working tree is uncommitted and another editor is active. Execute in place (no worktree). Do not commit unless the user asks; replace each "Commit" step with "run the full unit suite". Before editing a server file, check that no preparation is running in the dev server (`GET /api/preparation`), because saving server files restarts it.

## Review Focus

1. A hand-edited `lesson.json` with invalid JSON or a schema error → that item lists as broken with the error; every other item still lists and opens. (Task 2)
2. A title that slugifies to nothing (emoji only, punctuation only) or collides with an existing folder → `untitled`, then `-2`. (Task 1)
3. Two sections finishing at the same moment → both recorded in `progress.json`; no lost update. (Task 6)
4. The server killed in the middle of a write → the previous file is intact and readable. (Task 1)
5. Migration interrupted or run twice → second run finishes the job without duplicating folders or losing data; SQLite rows remain until verification passes. (Task 8)

---

### Task 1: Library folders primitive

**Files:**
- Create: `server/library.ts`
- Test: `tests/library.test.ts`

**Interfaces:**
- Produces:
  - `slugify(title: string, taken: Set<string>): string`
  - `class LibraryFs { constructor(root: string); dir(slug: string): string; exists(slug: string): boolean; slugs(): string[]; readJson<T>(slug: string, file: string): { value?: T; error?: string; mtimeMs: number }; writeJson(slug: string, file: string, value: unknown): void; writeText(slug: string, file: string, text: string): void; writeBytes(slug: string, file: string, bytes: Uint8Array): void; readBytes(slug: string, file: string): Buffer | undefined; rename(from: string, to: string): void; remove(slug: string): void; withLock<T>(slug: string, work: () => Promise<T>): Promise<T> }`
  - `mediaName(sourceIndex: number, assetIndex: number, label: string, ext: string): string` → e.g. `01-fig-03-attention-pattern.png`
  - `toServedSrc(slug: string, src: string): string` and `toStoredSrc(slug: string, src: string): string` (relative ⇄ `/api/library/<slug>/media/<file>`)

- [ ] **Step 1: Write failing tests** — `slugify('Understanding Jalapeño: fast inference!', new Set())` → `'understanding-jalapeno-fast-inference'`; `slugify('🧠🔥', new Set())` → `'untitled'`; `slugify('Interpretability', new Set(['interpretability']))` → `'interpretability-2'`; a 200-character title yields ≤ 60 characters without a trailing `-`. `writeJson` then a simulated crash (temp file left behind, rename never happened) leaves the earlier file readable by `readJson`. `readJson` on invalid JSON returns `{ error: /Unexpected|JSON/ }`, not a throw. `withLock` serializes two concurrent writers to the same slug (the second sees the first's write). `toServedSrc('a','media/x.png')` → `'/api/library/a/media/x.png'` and `toStoredSrc` reverses it; data URIs and `/assets/…` pass through unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/library.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** in `server/library.ts`. Atomic write: write `<file>.tmp-<pid>-<n>`, `fsync`, `rename`. `slugs()` ignores names starting with `.` or `_`. Locks are an in-process promise chain per slug.
- [ ] **Step 4: Run** the test file — expect PASS; run `npx vitest run` — all pass.

### Task 2: Folder-backed LessonStore and media route

**Files:**
- Modify: `server/store.ts` (content methods), `server/app.ts` (media, reveal, import checks), `server/index.ts` (library root, samples as folders), `shared/lesson.ts` (`isSafeAsset` accepts `/api/library/<slug>/media/<file>`), `shared/sources.ts` (`BundleSummary.broken?: string`, `LessonSummary.broken?: string`)
- Create: `server/library-render.ts`
- Test: `tests/store.test.ts`, `tests/api.test.ts`

**Interfaces:**
- Consumes: Task 1 `LibraryFs`, `slugify`, `toServedSrc`, `toStoredSrc`.
- Produces (unchanged names, new behaviour): `LessonStore` constructor becomes `new LessonStore(dbPath: string, libraryRoot: string)`; `list`, `get`, `insert`, `getBundle`, `saveBundle`, `listBundles`, `renameLesson`, `renameBundle`, `deleteLesson`, `deleteBundle`, `getProgress`, `setProgress`, `getSettings`, `saveSettings`, `isDeletedSample` keep their signatures. New: `resolveId(id: string): string | undefined` (slug or legacy ID → slug); `mediaPath(slug: string, file: string): string | undefined`; `libraryRoot: string`.
- `saveBundle(bundle, blobs)`: writes `item.json`, `sources/notes.md`, `sources/NN-<slug>.{md,html,json}`, media files named by `mediaName`; asset `src`/`originalSrc` become `media/<file>`. Returns the bundle with served srcs.
- `insert(lesson)`: writes `lesson.json` (relative srcs) + `lesson.md` + `CREDITS.md` into the bundle's folder when `sourceBundleId` resolves, otherwise a new folder from the title.
- `getAsset(hash)` is removed; callers use `mediaPath`.
- `library-render.ts`: `renderLessonMarkdown(lesson: Lesson): string`, `renderCredits(item: { title: string; sources: CapturedSource[]; lesson?: Lesson }): string`.

- [ ] **Step 1: Write failing tests** — round trip: `saveBundle` then `getBundle(slug)` returns the same sources with served srcs and `readBytes(slug,'media/…')` equals the blob bytes. `insert` of a prepared lesson writes `lesson.json` whose figure asset `src` starts with `media/`, and `get(slug).assets[0].src` starts with `/api/library/`. Hand edit: overwrite `lesson.json` with `{` → `list()` contains that item with `broken` matching `/lesson.json/` and still contains the other items; `get(slug)` throws `StoreError` 422 with the same message. Rename moves the folder and positions (`getProgress(newSlug)` keeps the block). Delete removes the folder. `resolveId('lesson-<old>')` returns the slug from `item.json.legacyIds`. API: `GET /api/library/<slug>/media/../../narad.sqlite` → 404; `GET …/media/01-fig-01-x.svg` has `Content-Disposition: attachment`; `POST /api/library/<slug>/reveal` with `Host: narad.example-tailnet.ts.net` → 403.
- [ ] **Step 2: Run** `npx vitest run tests/store.test.ts tests/api.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the folder-backed methods. SQLite: keep `settings`, `deleted_samples`; reading positions table becomes `positions(slug, mode, block_id, updated_at)`. Parse cache keyed by path + mtime. `index.ts` writes each sample as a folder (unless deleted), copying `public/assets/*.svg` into `media/` and rewriting srcs. `app.ts`: add media and reveal routes (`reveal` runs `execFile('open', [dir])`), resolve legacy IDs in `:id` routes, replace `/api/source-assets` checks in import with folder checks; export keeps embedding data URIs (read via `mediaPath`).
- [ ] **Step 4: Run** the two files, then `npx vitest run` and `npx tsc --noEmit` — all pass.

### Task 3: Warning kinds and lesson notes

**Files:**
- Modify: `shared/sources.ts` (`CaptureWarning`), `server/capture.ts`, `server/intake.ts`, `server/generation-content.ts`, `server/lesson-preparation.ts`, `src/components/SourcePreview.tsx`, `src/components/PreparationPanel.tsx`
- Test: `tests/capture.test.ts`, `tests/generation-content.test.ts`

**Interfaces:**
- Produces: `type CaptureWarning = { kind: 'blocking' | 'info'; message: string; assetId?: string }`; `CapturedSource.warnings: CaptureWarning[]`; `isBlocking(source: CapturedSource): boolean`; `legacyWarning(message: string): CaptureWarning` (known informational messages → `info`, anything else → `blocking`); `SourceUnit.kind` gains `'note'` for markdown units of the form `![<label>](source-note-<n>)`.
- Capture replaces each `canvas`, non-video `iframe` and `math` element with `![Interactive figure](source-note-<n>)` and an `info` warning carrying the page URL; merged-cell and TIFF warnings become `info`; failed visuals and empty article text stay `blocking`.
- Compile emits each note unit as a `callout` block, title `Not captured`, markdown `An interactive figure here could not be kept. [Open the original ↗](<url>)`, `spokenText` `An interactive figure in the original article could not be kept here.`, `origin: 'source'`. Note units are not sent to the agent as units to explain.

- [ ] **Step 1: Write failing tests** — a page with `<canvas>` and a merged-cell table captures with two `info` warnings and `buildTeachingPlan` succeeds; a page whose image download fails has a `blocking` warning and `buildTeachingPlan` throws `/capture/`; the compiled walkthrough contains a `Not captured` callout at the canvas position; `legacyWarning('A table contains merged cells. …').kind === 'info'`.
- [ ] **Step 2: Run** the two files — expect FAIL.
- [ ] **Step 3: Implement**; UI: SourcePreview lists info warnings as notes and blocking ones as issues; "ready" means no blocking warnings.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` — pass.

### Task 4: Credits and streamed videos in capture

**Files:**
- Modify: `shared/sources.ts` (`Credit`, `SourceAsset.kind` gains `'video'`, `SourceAsset.credit?`, `SourceAsset.video?`), `shared/lesson.ts` (asset `credit?`, `kind` gains `'video'`, `video?`), `server/capture.ts`, `server/intake.ts` (upload credit), `server/lesson-preparation.ts` and `server/generation-content.ts` (carry credit/video to lesson assets; video figure blocks)
- Test: `tests/capture.test.ts`, `tests/lesson.test.ts`

**Interfaces:**
- Produces: `type Credit = { pageTitle: string; pageUrl: string; mediaUrl?: string; caption?: string; creditLine?: string; license?: string; capturedAt: string }`; `type VideoRef = { provider: 'youtube' | 'vimeo' | 'file'; url: string; embedUrl: string }`; lesson schema: `video` required when `kind === 'video'`, `embedUrl` host restricted per Global Constraints.
- Credit line: text from the figure's `figcaption`, `cite`, `small`, or adjacent element matching `/\b(credit|source|image by|photo by|courtesy)\b|©/i`, trimmed to 300 characters. Licence: `link[rel=license]` href/text, an `a[href*="creativecommons.org/licenses"]`, or `meta[name=copyright|dc.rights]`; absent otherwise. Upload credit: `creditLine: 'Your upload: <file name>'`.
- Videos: `video[src]`, `video > source[src]`, iframes on `youtube.com`/`youtube-nocookie.com`/`player.vimeo.com`; YouTube `embedUrl` = `https://www.youtube-nocookie.com/embed/<id>`; poster downloaded as media when present; markdown placeholder `![<title>](source-asset-<n>)`. No video bytes requested.

- [ ] **Step 1: Write failing tests** — fixture page with `<figure><img><figcaption>Attention heads. Credit: Jane Doe</figcaption></figure>` and `<a href="https://creativecommons.org/licenses/by/4.0/">` → asset credit `{ creditLine: /Credit: Jane Doe/, license: /creativecommons/, pageUrl, mediaUrl }`; a YouTube iframe → `kind: 'video'`, `embedUrl` on `youtube-nocookie.com`, and the download stub was never called with the video URL; a `<video poster="p.jpg" src="v.mp4">` downloads only `p.jpg`; no `embedded media` warning for videos; lesson schema rejects a video asset whose `embedUrl` is `https://evil.example/embed`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**; the agent receives a video's title, caption and poster (as an image if present).
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` — pass.

### Task 5: Agent call runner

**Files:**
- Create: `server/runner.ts`
- Modify: `server/agent-runner.ts` (no behaviour change; export `AgentRequest` without `cwd`/`name` requirements moved to runner)
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes: `AgentRunner` from `server/agent-runner.ts`.
- Produces: `class CallRunner { constructor(dir: string, runner: AgentRunner, record: (call: CallRecord) => Promise<void>); run(input: { step: 'research' | 'author' | 'review' | 'summary'; task: string; prompt: string; schema: z.ZodType; images: string[]; provider: Provider; model?: string; timeoutMs: number }, signal: AbortSignal, onSession?: (pid: number | null) => void): Promise<unknown> }`; `type CallRecord = { n: number; step: string; task: string; startedAt: string; durationMs: number; outcome: 'ok' | 'retried' | 'failed'; error?: string }`.
- Files per call in `<dir>/calls/`: `NNN-<step>-<task>.prompt.md`, `.result.json`, `.log` (`NNN` zero-padded to 3). Numbering continues from the highest existing file on construction.

- [ ] **Step 1: Write failing tests** — two calls produce `001-author-r0-s00-p0.*` and `002-review-r0-s00-p0.*`; a runner constructed over a dir already holding `014-…` starts at `015`; a fake provider that fails once then succeeds yields one `retried` record and returns the value; failing twice rejects with the second error and records `failed`; output failing the zod schema counts as a failure; an aborted signal rejects without retrying.
- [ ] **Step 2: Run** `npx vitest run tests/runner.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; full suite passes.

### Task 6: Resumable preparation

**Files:**
- Modify: `server/preparation.ts`, `shared/preparation.ts`, `shared/settings.ts` (`preparation.sectionsAtOnce` 1–4 default 2), `src/components/SettingsPage.tsx` (one NumberField), `server/app.ts` (prepare body)
- Test: `tests/preparation-jobs.test.ts`

**Interfaces:**
- Consumes: Task 2 store (`resolveId`, `mediaPath`, `libraryRoot`), Task 5 `CallRunner`, Task 3 `isBlocking`.
- Produces: `type Progress = { runId: string; status: 'running' | 'interrupted' | 'stopped' | 'failed' | 'completed'; provider: Provider; level: Familiarity; startedAt: string; updatedAt: string; steps: { research: 'pending' | 'done' | 'skipped'; summary: 'pending' | 'done'; publish: 'pending' | 'done' }; sections: Record<string, { title: string; sourceHash: string; state: 'waiting' | 'writing' | 'reviewing' | 'done' | 'failed'; attempts: number; durationMs?: number; error?: string }>; calls: CallRecord[]; error?: string }`. `prepareInput` gains `action: 'continue' | 'restart'` (default `'continue'`). `PreparationService.start(slug, provider, familiarity?, action?)`. `PreparationState.jobs` items gain `slug`, `sections: { task: string; title: string; state: string; durationMs?: number; error?: string }[]`, `folder: string`.
- `sourceHash` = SHA-256 of the task's units' markdown joined with `\n\n` plus sorted asset IDs.
- Startup: every `progress.json` with `running` → `interrupted`, nothing launched.
- Restart: move `sections/`, `calls/`, `progress.json` to `preparation/runs/<timestamp>-abandoned/`.
- Publish: previous `lesson.json` + `preparation/settings.json` move to `preparation/runs/<timestamp>/`; write lesson, `lesson.md`, `CREDITS.md`.

- [ ] **Step 1: Write failing tests** — Continue after a run whose first 2 of 3 sections are done calls `author` only for the third; changing the source text of section 1 then Continue redoes section 1 only; a fresh `PreparationService` over a folder whose progress says `running` reports `interrupted` and has made no agent call; `sectionsAtOnce: 2` with a deferred fake runner has exactly 2 author calls in flight and, after both resolve in the same tick, `progress.json` shows both `done`; `restart` archives earlier sections and calls author for all; Stop leaves finished sections and status `stopped`; a published second version leaves the first under `preparation/runs/`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; all `progress.json` writes go through `LibraryFs.withLock`.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` — pass.

### Task 7: Reader and panel UI

**Files:**
- Modify: `src/components/PreparationPanel.tsx`, `src/components/LessonBlock.tsx`, `src/components/SourceVisual.tsx`, `src/components/Markdown.tsx`, `src/components/SourceDialog.tsx`, `src/components/Presentation.tsx`, `src/components/Library.tsx` (broken items), `src/lib/api.ts` (`reveal`, prepare `action`), `src/App.tsx` (legacy route replace), `src/styles.css`
- Create: `src/components/VideoEmbed.tsx`, `src/components/CreditLine.tsx`
- Test: `tests/library.e2e.ts`, `tests/intake.e2e.ts`

**Interfaces:**
- Consumes: Task 4 `Credit`, `VideoRef`; Task 6 job `sections`, `folder`, `action`.
- Produces: `<CreditLine credit={Credit} />` → `From <a>pageTitle</a> · original ↗ · licence`; `<VideoEmbed video={VideoRef} title={string} poster?={string} onPlay={() => void} />` (iframe with `allow="encrypted-media; picture-in-picture; fullscreen"`, `referrerpolicy="strict-origin-when-cross-origin"`, `loading="lazy"`; file videos `<video controls preload="none">`; always a `Watch at the source ↗` link). Playing a video calls `onPlay`, which pauses narration.
- Panel: per-section list, Continue (status `interrupted|stopped|failed`), Start over, Stop, Open folder, copyable folder path.

- [ ] **Step 1: Write failing e2e tests** — a lesson fixture whose figure asset has a credit shows `From <page title>` under the figure and in the Sources dialog; a video asset renders an iframe on `youtube-nocookie.com` and a `Watch at the source` link; clicking play pauses narration (narration state changes to paused); a broken item shows its error in the list; a seeded interrupted run shows Continue and the section list; `#lesson/<legacy id>` lands on `#lesson/<slug>`.
- [ ] **Step 2: Run** `npx playwright test tests/library.e2e.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full e2e and unit suites — pass.

### Task 8: One-time migration and salvage

**Files:**
- Create: `server/migrate.ts`
- Modify: `server/index.ts` (run before serving), `server/tutor-store.ts` (add `renameLesson(from: string, to: string): void`)
- Test: `tests/migrate.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `migrateToLibrary(options: { dbPath: string; dataDir: string; store: LessonStore; tutors?: { renameLesson(from: string, to: string): void } }): { migrated: number; salvaged: Record<string, number>; skipped: string[] }`.
- Steps per spec: backup to `data/backups/narad-<timestamp>.sqlite`; write folders from legacy tables (assets from `source_assets` blobs by hash); move `data/preparations/<jobId>` to `preparation/runs/legacy-<jobId>`; salvage approved sections whose source text matches `source-snapshot.json` into `sections/` with `progress.json` `interrupted`; positions → slugs; `legacyIds`; tutor thread rename; verify every folder via `store.get`/`getBundle`; only then delete legacy rows. Idempotent: an item whose `legacyIds` already contains the old ID is skipped.

- [ ] **Step 1: Write failing tests** — fixture DB (built with the legacy schema SQL) holding a bundle with one PNG asset, its prepared lesson, a position, and a legacy prep dir with 2 approved sections + snapshot: after migration the folder exists, `lesson.json` srcs are `media/…`, `CREDITS.md` names the page, positions resolve by slug, `resolveId(oldLessonId)` is the slug, legacy rows are gone, backup file exists. A second bundle without a lesson but with a legacy run salvages exactly the sections whose snapshot text matches (one altered section is not imported) and reports `interrupted`. Running `migrateToLibrary` twice changes nothing the second time. A folder that fails verification (simulate a write error) leaves all legacy rows in place and reports it in `skipped`. Tutor `renameLesson` is called with `(oldId, slug)`.
- [ ] **Step 2: Run** `npx vitest run tests/migrate.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `npx playwright test`, `npm run build` — all pass. Then, with the user's go-ahead, run the dev server once against the real `data/` and confirm `data/library/interpretebility/preparation/progress.json` shows 7 `done` sections.

### Task 9: Documentation

**Files:**
- Modify: `README.md` (data layout table, Continue / Start over, credits, videos, warnings), `docs/progress.md`

- [ ] **Step 1:** Replace the README data section with the folder tree from the spec and a short "Browsing and editing your library" paragraph.
- [ ] **Step 2: Run** the full unit suite — pass.
