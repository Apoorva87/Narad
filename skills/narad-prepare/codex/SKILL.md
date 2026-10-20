---
name: narad-prepare
description: Create a Narad lesson (quick summary, detailed walkthrough, tutor dialogue) from article links, notes, a topic, or images, using the local Narad app. Use when the user asks to make, prepare, continue, or check a Narad lesson or analysis.
---

Narad runs locally; this skill drives it through its command-line helper. All commands run from the Narad repository:

    cd "{{NARAD_DIR}}"

The API defaults to http://127.0.0.1:4318 (`NARAD_API_URL` overrides it). If `node --import tsx scripts/narad.ts status` says Narad is not reachable, start it with `./start.sh start` (Docker) or `./start_local.sh start`, then retry.

## Create a lesson

1. Write an input JSON file outside the repository, e.g. `/tmp/narad-input.json`:
   `{ "title": "...", "text": "learning intent, notes and/or up to 8 article URLs", "images": [{ "name": "plot.png", "data": "data:image/png;base64,..." }] }`.
   `title` and `images` are optional. Keep the user's learning intent in `text`. A topic alone (no links) is fine: Narad researches articles first. Never put secrets in the input.
2. Save the sources, choosing the learner level the user asked for (default foundational):
   `node --import tsx scripts/narad.ts add /tmp/narad-input.json --level foundational|some-background|advanced`
   It prints the item slug and any capture warnings. `note:` warnings (interactive figures, merged tables) do not block preparation; they appear as "Not captured" notes in the lesson. `BLOCKING:` warnings (article text or an image failed to save) must be fixed before preparing — tell the user; retrying the source in the app usually resolves it.
3. Start preparation with the agent the user prefers (default codex):
   `node --import tsx scripts/narad.ts prepare <slug> codex`
   If every preparation slot is busy (Settings → Preparation → Lessons at once), Narad queues the item automatically and prints `Queued (position N)`; it starts on its own when a slot frees up. Report the queue position to the user. Never stop someone else's run to make room.
4. Check progress at sensible intervals (a long article can take an hour or more):
   `node --import tsx scripts/narad.ts status <slug>`
   Only status `completed` means a lesson was published. Report `failed`, `stopped` or `interrupted` honestly with the error shown.
5. Give the user the reader link: `node --import tsx scripts/narad.ts link <slug>`, and the folder path from `status` (sources, media, CREDITS.md, lesson.json and the agent's prompts/results live there).

## Continue, start over, stop

- Interrupted, stopped, or failed runs keep their finished sections. `prepare <slug> <agent>` continues from the first unfinished section. Add `--restart` only when the user explicitly wants to start over (finished sections are archived, not deleted). Changing `--level` on a run in progress also starts over.
- `node --import tsx scripts/narad.ts stop <slug>` stops only that item's run, or removes it from the queue if it is still waiting. Never kill unrelated Codex or Claude processes.

## Limits

This skill prepares lessons; it does not play narration or answer tutor questions (those happen in the app). Prompts and defaults for preparation are set in the app's Settings page.
