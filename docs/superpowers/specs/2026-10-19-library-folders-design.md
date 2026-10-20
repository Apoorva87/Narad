# Library folders, resumable preparation, credits, and streamed videos

Status: approved · 2026-10-19

## Why

A long "interpretability" preparation (32 sections) was cut off twice by API server restarts. The finished sections were already saved, but in a randomly named scratch folder that nothing reads back, so the retry started again at 0/32. Lessons, sources and images also live inside `data/narad.sqlite`, where the user cannot read, edit or copy them, and the origin of captured images is recorded per image but never shown as credit.

The user wants:

- every saved item in a fixed, readable place on disk that they can **read, modify and copy**;
- an interrupted preparation that **continues where it stopped** when they ask it to;
- agent (Claude/Codex) calls that are simple, consistent, and inspectable;
- **credits** for every image taken from somewhere else;
- videos in captured pages **streamed from their original source**, never stored.

## Goals

1. One folder per library item, created when its sources are saved, with a defined structure.
2. Folders are the source of truth for content. Hand edits are picked up; copying a folder into another library works.
3. Preparation progress is recorded per section. **Continue** reuses finished work; **Start over** is explicit.
4. Every agent call leaves a readable prompt, result and log, named in order.
5. Image credits are captured, written to `CREDITS.md`, and shown in the reader.
6. Videos (`<video>`, YouTube, Vimeo) are recorded as links and embedded from the source.
7. Existing lessons, sources, samples and the salvageable interpretability sections move into the new structure.

## Non-goals

- Interactive snapshots of JavaScript figures (deferred by the user; "#3").
- Automatic resumption. After any interruption, a run waits for the user to press Continue. *(User decision.)*
- Regenerating existing lessons when settings change. Settings apply to future calls only. *(User decision.)*
- Token budgets or cost controls. *(User decision.)*
- New monitoring beyond a per-section status list and an Open folder action. *(User: current monitoring is "pretty decent".)*

## Anti-goals

- Losing finished preparation work to an interruption.
- A hand edit that makes the whole app fail to load. A broken item must fail alone, with its error visible.
- Downloading or storing video files.
- Silent data loss during migration.

## Folder structure

Root: `<data dir>/library/` (default `data/library/`; `NARAD_DATA_DIR` already moves the data dir).

```
data/library/
  interpretability/
    item.json              title, createdAt, level, status, legacyIds; the item's identity is the folder name
    lesson.json            the finished lesson (absent until prepared); hand-editable
    lesson.md              readable export of the walkthrough, regenerated on publish
    CREDITS.md             regenerated whenever sources or the lesson change
    sources/
      notes.md             the user's notes and request
      01-<slug>.md         captured article text (Markdown)
      01-<slug>.html       original page snapshot
      01-<slug>.json       capture metadata: URL, warnings, inventory, asset list with credits
    media/
      01-fig-03-<slug>.png displayed images (raster, or PNG preview of an SVG)
      01-fig-03-<slug>.svg original SVG, kept for download
      01-poster-02.jpg     video poster images (videos themselves are never stored)
    preparation/
      progress.json        run state, per-section state, per-call records
      settings.json        settings used by the latest attempt
      sections/<task>.json each approved section
      calls/NNN-<step>-<task>.prompt.md / .result.json / .log
      runs/<timestamp>/    lesson.json and settings.json of earlier published versions
```

Rules:

- **Identity is the folder name** (slug). Routes become `#lesson/<slug>` and `#sources/<slug>`; `lesson.id` and `lesson.sourceBundleId` are set to the slug when read. A copied folder under a new name is a separate item.
- **Old IDs keep working.** `item.json.legacyIds` lists the item's former lesson and bundle IDs. The API resolves a legacy ID to its slug, and the client replaces `#lesson/<old id>` with the slug route. Features keyed by lesson ID (reading positions, and the planned contextual tutor's threads) translate through the same lookup, so migration does not orphan their data. *(Builder's call, prompted by `2026-10-19-contextual-tutor.md`.)*
- **Slugs** are lowercase ASCII from the title (accents removed, `Jalapeño` → `jalapeno`), words joined by `-`, at most 60 characters, with `-2`, `-3`… on collision.
- **Renaming in the app** updates `item.json`/`lesson.json` titles and renames the folder; reading positions move with it. Renaming a folder in Finder makes it a new identity (positions reset). *(Builder's call, documented.)*
- **Paths inside `lesson.json` are relative** (`media/01-fig-03-attention.png`). The API rewrites them to `/api/library/<slug>/media/<file>` when serving and back when saving. `isSafeAsset` accepts both forms.
- **Media files** are served by `GET /api/library/:slug/media/:file` with a strict filename check (no path separators or `..`), `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`; SVGs are served as downloads only, as today.
- **Hand edits:** Narad reads folders on each list or open request, caching parsed files by modification time. Invalid JSON or a schema failure marks that item as broken in the library ("lesson.json: walkthrough.sections.2.blocks.0.spokenText is empty") and leaves other items working.
- **Writes are atomic** (write a temporary file, then rename) and serialized per item.
- **SQLite keeps only app state:** settings, deleted-sample markers, and reading positions keyed by slug. Lesson, bundle, asset and job tables are emptied after migration.
- **Samples** from `content/samples.json` are written as folders on startup (unless deleted), with their bundled `/assets/*.svg` copied into `media/` so the folder is self-contained.
- **Delete** removes the folder and its reading positions.
- **Export** keeps embedding images as data URIs (existing behaviour); copying the folder is the other way to share.

## Preparation: resumable and inspectable

### progress.json

```json
{
  "runId": "2026-10-19T22-30-00Z",
  "status": "running | interrupted | stopped | failed | completed",
  "provider": "codex",
  "level": "foundational",
  "startedAt": "...", "updatedAt": "...",
  "steps": { "research": "done | skipped | pending", "summary": "pending", "publish": "pending" },
  "sections": {
    "r0-s01-p1": { "title": "1. Starting from Nvidia GPUs", "sourceHash": "sha256…", "state": "waiting | writing | reviewing | done | failed",
                   "attempts": 1, "durationMs": 201000, "error": null }
  },
  "calls": [ { "n": 14, "step": "review", "task": "r0-s03-p0", "startedAt": "...", "durationMs": 61000, "outcome": "ok | failed | retried", "error": null } ]
}
```

### Behaviour

- **Continue** reloads `progress.json` and the current sources, rebuilds the teaching plan, and reuses every section whose `sourceHash` (SHA-256 of the section's units and asset IDs) matches a saved `sections/<task>.json`. Sections whose source changed, or whose task ID no longer exists (for example after changing chunk-size settings), are written again. Research is skipped if already done.
- Remaining calls use the **current** settings; the reused sections stay as they are. Each attempt records its settings in `preparation/settings.json`.
- **Start over** moves `sections/`, `calls/` and `progress.json` into `runs/<timestamp>-abandoned/` and starts fresh.
- **Interruption:** on startup, any `progress.json` with status `running` becomes `interrupted`. Nothing restarts automatically. *(User decision.)*
- **Stop** sets status `stopped`; finished sections are kept.
- **Transient failure:** a single failed agent call (non-zero exit, timeout, unparseable output) is retried once automatically. A second failure marks the section `failed` and the run `failed`, with the error shown; Continue retries it.
- **Concurrency:** sections are prepared two at a time by default (Settings → Preparation → "Sections at once", 1–4). Only one item is prepared at a time across the library, as today.
- **Publish:** the summary and compile steps run after all sections are done. The previous `lesson.json` (if any) moves to `runs/<timestamp>/`, the new one is written atomically, and `lesson.md` and `CREDITS.md` are regenerated.
- **Agents panel** lists runs found across item folders, newest first.

### The runner

One module performs every call the same way: allocate the next call number; write `calls/NNN-<step>-<task>.prompt.md`; run the CLI (existing process-group handling and cancellation are kept); stream output into `.log`; validate the result against the step's schema; write `.result.json`; append the call record to `progress.json`. Providers differ only in argument building (existing `providerArgs`). Claude's image-reading note stays an internal detail of argument building.

### Preparation panel

Shows run status; a per-section list (title, state, duration, error); buttons **Continue** (when interrupted, stopped or failed), **Start over**, **Stop** (while running), and **Open folder**; plus the folder path as copyable text. **Open folder** calls `POST /api/library/:slug/reveal`, which runs `open <path>` on macOS and is allowed only for loopback requests.

## Credits

Captured for every source image and video, stored in the source's `01-<slug>.json` and on lesson assets as an optional `credit` object:

```json
{ "pageTitle": "...", "pageUrl": "https://...", "mediaUrl": "https://...", "caption": "...", "creditLine": "Figure by …", "license": "CC BY 4.0", "capturedAt": "..." }
```

- **creditLine:** text in the figure's `figcaption`, `cite`, `small`, or an adjacent element matching credit wording (`credit`, `source`, `image by`, `photo by`, `courtesy`, `©`), trimmed to 300 characters.
- **license:** the page's `link[rel=license]`, a Creative Commons link in the page, or `meta` copyright/rights; otherwise absent (never guessed).
- **Uploads:** "Your upload: <file name>".
- `CREDITS.md` groups entries by source page, lists each figure with its media file name, and includes every source page link.
- The reader shows a credit line under each source figure ("From *page title* · original image ↗ · licence") and lists all credits in the Sources dialog. Presentation mode shows the credit line under the held figure.
- Lesson export carries the `credit` objects.

## Streamed videos

- Capture records `video[src]`, `video > source[src]`, and iframes whose host is `youtube.com`, `youtube-nocookie.com` or `player.vimeo.com` as assets of kind `video` with `{ provider: youtube | vimeo | file, url, embedUrl, posterFile? }`. A poster image is downloaded into `media/` when the page provides one. Video files are never downloaded.
- Videos no longer produce the "embedded media" warning. Other iframes, canvases and MathML still warn.
- The agent receives the video's title, caption and poster (if any) and explains what it shows; the lesson includes a figure block referencing the video asset.
- The reader embeds the player streaming from the source: YouTube via `youtube-nocookie.com`, Vimeo via its player, files via `<video controls preload="none">`. A "Watch at the source ↗" link is always shown, and is the only thing shown if the embed fails or the device is offline. Narration does not play over a playing video: starting a video pauses narration.
- Lesson schema: asset `kind` gains `video`; `src` is the poster (or a bundled placeholder); a `video` object holds `provider`, `url`, `embedUrl`, with `embedUrl` restricted to the three hosts above or the original `https` file URL.

## Capture warnings

Warnings are split into two kinds. *(User go-ahead on the recommended option.)*

- **Blocking:** the article text could not be read, or an image or video poster failed to save. These still stop preparation until a refresh fixes them.
- **Informational:** interactive pieces (canvas, non-video iframes, MathML), merged table cells, TIFF first-page previews. These never block preparation. Each becomes a visible note in the lesson at its place in the source ("An interactive figure here could not be kept. Open the original ↗"), and is listed in the source view.

Each warning is stored as `{ kind: 'blocking' | 'info', message, assetId? }`. Existing string warnings migrate by matching their known messages; unknown ones are treated as blocking.

## Migration (runs once at startup)

1. Copy `narad.sqlite` to `data/backups/narad-<timestamp>.sqlite`.
2. For each source bundle and lesson in SQLite: create the item folder, write sources, media (from `source_assets`, with readable names), credits (from recorded `originalUrl`, page URL and captions), `lesson.json` with relative paths, `lesson.md`, `CREDITS.md`. Lessons without a bundle become items with only `lesson.json`.
3. Move each `data/preparations/<jobId>/` into its item's `preparation/runs/legacy-<jobId>/`.
4. **Salvage:** for an item with no published lesson, take the most recent legacy run with `*.approved.json` files and its `source-snapshot.json`. Import each approved section whose source text still matches into `sections/`, and write a `progress.json` with status `interrupted`. *(This makes the interpretability run continue at section 8.)*
5. Map reading positions to slugs and record each item's former IDs in `legacyIds`.
6. Re-read every written folder and validate it. Only if all succeed, empty the content tables. On any failure, keep SQLite untouched, log which item failed, and continue serving from SQLite. Migration retries on the next start.

## Settings additions

- Preparation → **Sections at once** (1–4, default 2).
- No settings for the library location (it follows the data directory).

## Testing expectations

- Store: folder round-trip, hand-edit pickup, broken-item isolation, rename/delete, slug collisions, atomic writes.
- Preparation: Continue reuses matching sections and redoes changed ones; interruption marks `interrupted` without auto-restart; transient retry; concurrency of two with serialized progress writes; Start over archives.
- Migration: fixture database with bundles, lessons, assets, positions and a legacy run; salvage imports only matching sections; failure leaves SQLite intact.
- Capture: credit lines, licence detection, YouTube/Vimeo/file videos, posters, no video downloads.
- End-to-end: Continue after a simulated restart, credits visible in the reader, video embed with fallback link, folder path shown.

## Left to the builder

- Exact module split (suggested: `server/library.ts` for folders, `server/runner.ts` for calls, the existing `server/preparation.ts` slimmed to orchestration).
- Mtime cache details and the `lesson.md` layout.
- Readable media file names beyond the `NN-fig-NN-<slug>` pattern.
- UI styling of the section list and credit lines, following the existing design.
