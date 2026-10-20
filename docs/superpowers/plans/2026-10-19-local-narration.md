# Local Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver Part 3: local expressive narration, persisted voice/rate preferences, passage highlighting, navigation, interruption, and reusable audio.

**Architecture:** Existing Express server owns one lazy persistent Python/MLX speech worker through JSON lines. Speech requests reference saved lesson blocks and bounded sentence chunks; the server derives spoken text and hashes model/voice/style/text for local WAV caching. A browser audio controller owns playback, cancellation generations, next-chunk prefetch, and passage advancement.

**Tech Stack:** Existing React/TypeScript/Express; Python 3.12, pinned MLX Audio, Qwen3-TTS 1.7B CustomVoice on Apple Silicon.

**Spec:** docs/superpowers/specs/2026-10-19-narad-design.md

## Global constraints
- Local single-user app; no cloud speech, voice cloning, or new supervisor service.
- Use saved spoken text; retain all content and visuals. Highlight passages, not invented word timestamps.
- Voice/rate changes, previous/next passage and section, mode switches, leaving reader, and pause must prevent stale audio.
- Part 4 contextual tutoring and familiarity adaptation remain subsequent work.
- Preserve existing checkout and uncommitted approved checkpoints; user authorized continuing the running app. No repeat plan approval or worktree move.

## Review focus
- Long technical narration must not be truncated or reorder sentence chunks.
- Slow old responses must not play after navigation, pause, voice change, or unmount.
- Failed/missing model, invalid voice, subprocess exit, and cancelled generation must remain retryable with clear errors.
- Cache must distinguish content, voice, style and model; incomplete audio must never become a cache hit.
- Browser autoplay restrictions, audio end, and mobile controls must retain a usable reading position.

### Task 1: Speech contracts and local generation
**Files:** shared/speech.ts; server/speech.ts; server/speech-worker.ts; speech/worker.py; speech/pyproject.toml; server/app.ts; server/index.ts; tests/speech.test.ts.
**Interfaces:** splitSpeech(text): string[]; SpeechService.status(), render({lessonId, mode, blockId, chunk, voice}, signal): Promise<{url, duration, cached}>; Worker.synthesize(text, voice, style, signal): Promise<Buffer>, close(). GET /api/speech; POST /api/speech/render; GET /api/speech/audio/:hash.
- [x] Write failing tests for lossless bounded chunks, cache identity/reuse, invalid references, cancellation and failure nonpublication.
- [x] Implement lazy worker, bounded serialized requests, cache files, cancellation, API validation, status, and shutdown.
- [x] Pin/install local speech environment and model; measure real generation latency and audio duration for two preset voices.

### Task 2: Reader playback
**Files:** src/lib/narration.ts; src/hooks/useNarration.ts; src/components/SpeechControls.tsx; src/components/Reader.tsx; src/styles.css; src/App.tsx; tests/narration.test.ts; tests/speech.e2e.ts.
**Interfaces:** NarrationController plays ordered chunk records with block IDs, handles pause/resume/stop/settings and reports {status, blockId, error}; React hook integrates active passage and saved preferences.
- [x] Write failing behavioral tests for stale async responses, pause/resume, automatic advancement, mode/unmount stop, voice change, and immediate rate changes.
- [x] Implement one audio element, one-chunk prefetch, cancellation tokens, voice assignments for narrator/host/expert, persisted settings, accessible compact playback controls.
- [x] Verify browser playback with WAV fixtures, highlighting, section navigation, mobile fit, and error recovery.

### Task 3: Live validation and handoff
**Files:** README.md; docs/progress.md; artifacts/ (ignored).
- [x] Run real local narration through API and browser; save two voice samples and report measured latency without claiming subjective listening approval.
- [x] Run full unit/browser tests, production build, and independent code review; fix material findings.
- [x] Document setup, cache, limits, measured results and exact checkpoint; stop for listening feedback before Part 4.

## Execution ledger
Pre-flight: saved lesson block IDs and spokenText feed both server validation and browser chunk order; shared splitting ensures identical indices. Audio playback changes active passage through the existing progress saver.
Ruling: continue in the running checkout, preserving earlier checkpoint work; use inline implementation and one final reviewer. Approved product spec and current continuation authorize this checkpoint.

Task 1 complete: seven service/chunk tests; real model downloaded and tested. Task 2 complete: five controller tests and three real-browser WAV playback tests. A browser regression caught delayed stop on reader-back; stop now occurs synchronously in its click handler.

Final review: two material findings (queued generation during shutdown and poisoned cache retries) reproduced RED, fixed GREEN. No other material findings. Full unit/integration suite: 73 passed. Full browser suite: 16 passed. TypeScript and production build passed. Real web playback and cancellation/retry succeeded; model warm after completion. No subjective listening approval claimed.

## Subsequent user-approved revision

User approved the voices and rejected saved article audio to avoid disk growth. The implementation now uses direct, non-cacheable WAV responses and bounded browser-memory audio, with no disk cache or saved audio endpoint. Temporary URLs are explicitly released. Replays generate again; host model remains resident. Existing generated WAVs removed. Current verification and independent-review record are in docs/progress.md. The earlier cache design above is historical and superseded by this instruction.
