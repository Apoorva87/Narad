---
name: narad-prepare
description: Create a Narad lesson (quick summary, detailed walkthrough, tutor dialogue, course) from article links, notes, a topic, or images, using the local Narad app. Use when the user asks to make, prepare, continue, or check a Narad lesson or analysis.
---

Narad runs locally; drive it with its command-line helper through the Bash tool. Run every command from the Narad repository:

    cd "{{NARAD_DIR}}"

The API defaults to http://127.0.0.1:4318 (`NARAD_API_URL` overrides it). If `node --import tsx scripts/narad.ts status` reports Narad is not reachable, start it with `./start.sh start` (Docker) or `./start_local.sh start`, then retry.

## Create a lesson

1. Write the input JSON to a temporary file (not inside the repository), e.g. `/tmp/narad-input.json`:
   `{ "title": "...", "text": "learning intent, notes and/or up to 8 article URLs", "images": [{ "name": "plot.png", "data": "data:image/png;base64,..." }] }`.
   `title` and `images` are optional; a topic with no links is fine (Narad researches articles first). For a local image, build the data URL with a shell command such as `printf 'data:image/png;base64,%s' "$(base64 -i plot.png)"` rather than pasting base64 yourself. Keep the user's learning intent in `text`; never include secrets.
2. Save the sources at the learner level the user wants (ask only if it matters and they haven't said; default foundational):
   `node --import tsx scripts/narad.ts add /tmp/narad-input.json --level foundational|some-background|advanced`
   It prints the item slug and capture warnings. `note:` warnings (interactive figures, merged tables) don't block preparation — they become "Not captured" notes in the lesson. `BLOCKING:` warnings mean article text or an image failed to save, or numbered figures were referenced but no visuals were captured. Tell the user what is missing; retry the source in the app or inspect the original page and add the figures. If they cannot be recovered, ask whether the user wants to proceed without them. Never imply that uncaptured figures were preserved.
3. Start preparation with the agent the user prefers; if they don't say, use `claude`:
   `node --import tsx scripts/narad.ts prepare <slug> claude`
   If every preparation slot is busy (Settings → Preparation → Lessons at once), Narad queues the item automatically and prints `Queued (position N)`; it starts on its own when a slot frees up. Tell the user the queue position. Never stop someone else's run to make room.
4. Preparation runs in the background inside Narad and can take an hour or more for a long article. Check `node --import tsx scripts/narad.ts status <slug>` occasionally (minutes apart, not in a tight loop) or tell the user how to check. Only status `completed` means the lesson was published; report `failed`, `stopped` or `interrupted` honestly, including the error.
   If `status` shows `waiting for topic choices in the app`, the user turned on “Steer the research” there: nothing is running, and the lesson continues only after they pick topics in the app (tell them; do not restart it unless they ask).
5. Share the reader link (`node --import tsx scripts/narad.ts link <slug>`) and the folder path from `status`, where the sources, media, CREDITS.md, lesson.json and every agent prompt/result are saved.

## Continue, start over, stop

- Interrupted, stopped or failed runs keep their finished sections; `prepare <slug> <agent>` continues from the first unfinished one. Use `--restart` only when the user explicitly asks to start over (finished sections are archived). Changing `--level` on an unfinished run also starts over — confirm with the user first.
- `node --import tsx scripts/narad.ts stop <slug>` stops only that item's run, or removes it from the queue if it is still waiting. Never kill unrelated Codex or Claude processes.

## Limits

This skill prepares lessons; narration and tutor questions happen in the app. Preparation prompts and defaults are edited in the app's Settings page, not here.
