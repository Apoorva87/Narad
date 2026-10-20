# Tailscale and Mobile Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Narad privately reachable through Tailscale, show voice-service health throughout the app, and improve bounded background playback continuity on mobile Safari.

**Architecture:** Keep Express and the speech worker bound to loopback, and admit one exact configured HTTPS proxy origin. Add an independent global status component that reads the existing speech-status endpoint. Retain the single HTML audio element and expand temporary look-ahead buffering without writing audio to disk; package the UI with Home Screen metadata while preserving the existing Media Session controls.

**Tech Stack:** TypeScript, Express, React, HTML Media Session, Web App Manifest, Vitest, Playwright, Tailscale Serve.

**Spec:** `docs/superpowers/specs/2026-10-19-narad-design.md`

## Global Constraints

- Do not modify preparation jobs, preparation schemas, agent runners, or preparation UI; another agent owns that work.
- Keep the API and speech worker listening on `127.0.0.1`.
- Allow only one exact configured remote HTTPS origin; retain existing localhost and cross-site-write protections.
- Keep generated audio temporary and bounded in memory; never save article audio.
- Treat real iPhone Safari behavior as a required manual validation after automated browser checks.
- Do not commit from the shared dirty checkout; commits could capture another agent's concurrent changes.

## Review Focus

- A forged Host without configured origin must remain rejected.
- A configured Tailscale Host and same Origin must work for both reads and writes.
- Voice status must distinguish available, loading, ready, speaking, unavailable, and unreachable.
- Pausing, stopping, navigation, and disposal must release every look-ahead audio object.
- Background continuation must not autoplay before the learner presses Listen.

---

### Task 1: Exact reverse-proxy origin

**Files:**
- Create: `server/request-access.ts`
- Modify: `server/app.ts`
- Modify: `server/index.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Produces: `apiRequestAllowed(request, webOrigin?)` and optional `createApp(..., { webOrigin })` configuration.

- [x] Write failing API tests for configured HTTPS Host/Origin acceptance and forged Host rejection.
- [x] Run the focused API tests and verify the configured origin case fails.
- [x] Implement exact Host/Origin validation and pass `NARAD_WEB_ORIGIN` from the server entry point.
- [x] Run the focused API tests and verify they pass.

### Task 2: Global voice health

**Files:**
- Create: `src/components/VoiceStatus.tsx`
- Create: `src/components/VoiceStatus.css`
- Modify: `src/App.tsx`
- Test: `tests/speech.e2e.ts`

**Interfaces:**
- Consumes: existing `api.speechStatus()` and `SpeechStatus`.
- Produces: a responsive `VoiceStatus` component with a five-second health poll.

- [x] Write a failing browser test that shows voice health in the library and mobile header.
- [x] Run the focused browser test and verify the indicator is absent.
- [x] Implement the isolated component and add one integration point in `App.tsx`.
- [x] Run the focused browser test and verify state changes and mobile fit.

### Task 3: Bounded mobile playback readiness

**Files:**
- Modify: `src/lib/narration.ts`
- Modify: `tests/narration.test.ts`
- Create: `public/manifest.webmanifest`
- Modify: `index.html`
- Test: `tests/speech.e2e.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: three-segment temporary look-ahead, complete cancellation/release semantics, and installable Home Screen metadata.

- [x] Write a failing unit test proving the current segment plus three following segments begin preparation.
- [x] Run it and verify the existing one-segment look-ahead fails the expectation.
- [x] Generalize look-ahead ownership to a bounded map and preserve pause/stop/dispose cleanup.
- [x] Add a browser test for Media Session metadata/actions and continuation after a hidden-page transition.
- [x] Add the web app manifest and document Tailscale Serve, host startup, voice lifecycle, and iPhone validation limits.
- [x] Run unit, browser, build, and formatting verification.
