# Narad product requirements

Status: consolidated from the user's confirmed decisions; implementation authorized on 2026-10-19. Deliver in four parts, with user feedback before advancing beyond each part.

## Purpose
Turn resources or a research topic into faithful, understandable lessons that the user can read, hear, and discuss with a tutor. Content quality and visual explanation are central. Agent session management is deliberately minimal.

## Confirmed requirements
- Inputs: links, files/resources, or a topic; initiate through Codex/Claude or the local web UI. Save analyses in a browsable library.
- Quick summary: roughly 3–4 lines per resource plus a synthesis. May omit details; retain access to sources.
- Detailed walkthrough: follow source sections and retain all factual claims, values, units, equations, assumptions, qualifications, figures, and tables. Explain difficult concepts and dense paragraphs with definitions, intermediate reasoning, examples, and diagrams. Flag unreadable/missing source material rather than silently omit it.
- Tutor dialogue: host/expert script, natural educational conversation, preserved relevant visuals. Never read speaker labels or stage directions as narration.
- Keep source-derived claims distinguishable from teaching additions. A source-element coverage map supports omission checking; it does not alone certify accuracy.
- Structured saved lessons contain sections, stable block IDs, display Markdown/math, spoken text, source references, visuals, and revisions. Assets are saved locally, not regenerated on every opening.
- Familiarity per analysis: Foundational (default), Some background, Advanced. Optional assessment recommends a level. Adapt one section or a whole walkthrough, preview before accepting, retain earlier versions. Familiarity never reduces detailed factual coverage.
- Playback: local expressive TTS, voice/rate controls, play/pause, previous/next paragraph and section, direct navigation, highlighting and scrolling, visuals in context.
- Ask tutor stops audio immediately, preserves position, opens a contextual independent discussion. Responses appear progressively and are spoken in coherent chunks. Follow-ups and optional illustrated detours remain attached to the passage. User can explore, keep, bypass, and resume.
- Web app launches agents in the background and shows app-owned running sessions and stop controls. Save conversations/results when stopping. No separate supervisor service or sophisticated recovery dashboard.
- Initial lessons are prepared and checked before marked ready. Follow-up answers may stream.
- Provisional speech choice: Qwen3-TTS 1.7B CustomVoice through MLX Audio; acceptance depends on listening/latency tests on M4 Max / 128 GB.
- Local single-user app; no hosting, accounts, collaboration, or cloud speech required for version one.

## Four feedback checkpoints
1. **Reader and content foundation:** persistent library, three mode rendering, source viewer, math, local diagrams, section/block navigation, saved reading position, validated prepared-lesson import/export. Two explicitly authored sample lessons demonstrate the contract. Generation, speech, and tutoring are visibly unavailable until their own stages.
2. **Research and preparation:** resource ingestion, extraction including original visual assets, source inventory, agent generation, structural and content checks, simple jobs/session controls, Codex skill entry point. Validate against an actual article/paper with the user.
3. **Speech:** local server setup and listening comparison, chunked narration, voice selection, rate changes, audio reuse, navigation/highlighting and interruption. Do not promise exact word timing without measured support.
4. **Interactive tutor and adaptation:** contextual questions, streamed answers/audio, optional detours, accept/bypass/resume, familiarity assessment and revisions.

Stop after each checkpoint, demonstrate working behavior and limits, and request feedback. Do not build stages 2–4 in stage 1.

## Builder decisions (not claimed as user preferences)
- Working name/folder Narad, using the existing empty folder unless user directs otherwise.
- React + TypeScript + Vite UI, small Express backend in the same TypeScript project, Node built-in SQLite, local asset files. This keeps lesson types shared without a second service for routine storage.
- Node >=24. One command runs the API and UI. API binds loopback. No external account keys needed for stage 1.
- Versioned JSON lesson contract validated with Zod; Markdown rendered without raw HTML, equations via KaTeX. Imported bundles may embed raster assets as data URLs; packaged demo SVGs are served as local images. Arbitrary remote/HTML assets are not executed.
- Source records store an original Markdown snapshot and locator labels. Every block cites a source/locator or explicitly identifies itself as a teaching addition. Source coverage status is reported honestly; sample content isn't a claim of comprehensive extraction of an external paper.
- SQLite stores analysis documents and per-mode reading positions. Figures for samples are repository assets. Imported lessons use their own IDs; duplicates are rejected, not overwritten.
- Store the display/spoken pair together; spoken text is required for explanatory blocks, equation explanations and figure descriptions.
- Reader design: cool white and pale blue surfaces, ink text, blue accent, readable serif lesson prose with system sans navigation. Left library navigation, central content, compact section outline on wide screens. Mobile stacks navigation and keeps math scrollable.

## Stage 1 acceptance
- Browse and search two labeled sample analyses; open each available mode with actual distinct content.
- Read equations, tables, and saved figures with captions/alt text and source attribution.
- Open original source snapshots. Identify teaching additions.
- Navigate paragraphs/sections; refresh and resume the selected block/mode.
- Import/export valid prepared lessons. Reject malformed content, duplicate IDs, missing references and unsafe assets with actionable errors and no partial saves.
- Keep readiness truthful: no fake speech, generation, tutor answers, familiarity rewrites, or session counts.
- Usable at desktop and mobile widths, keyboard accessible controls, visible focus, readable errors.

## Later acceptance focus
Source coverage and mathematical fidelity; genuinely natural spoken scripts; cancellation of stale audio; coherent paragraph boundaries; source-backed answers; retained revision history. TTS performance, agent invocation details, original figure extraction quality, and long-paper limits must be measured during their stages.

## Non-goals
Full process orchestration platform, multi-user deployment, voice cloning studio, automatic publication, and claiming model output is infallible.
