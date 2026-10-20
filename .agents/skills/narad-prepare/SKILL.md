---
name: narad-prepare
description: Save resources or a learning topic in the local Narad app and prepare its summary, detailed walkthrough, and tutor dialogue. Use when the user asks to create a Narad lesson from links, text, or images.
---

Use the running Narad server and its preparation API. Work from the Narad repository directory. Start `npm run dev` only if the local server is not running. The default API is http://127.0.0.1:4318; `NARAD_API_URL` overrides it.

1. Save a JSON input file with `title`, `text` (ideas and/or up to 8 article URLs), and optional `images` entries `{name,data}` using PNG/JPEG/WebP data URLs. Preserve the user's learning intent. Never place secrets in the input.
2. Run `node --import tsx scripts/narad.ts add <input.json>`. Review capture warnings before preparing; an incomplete capture must be retried or corrected, not silently omitted.
3. Run `node --import tsx scripts/narad.ts prepare <bundle-id> codex` (or `claude`, respecting the user's choice). This starts a background job through the same path as the web interface and uses the selected CLI's account. If another preparation is active, report it rather than stopping it without user direction.
4. Check `node --import tsx scripts/narad.ts status` at sensible intervals. Only `completed` with `lessonId` means a lesson was published. Report a failure or interrupted job honestly. Do not claim successful tutoring from a source capture alone.
5. Return the reader link `http://127.0.0.1:5178/#lesson/<lesson-id>` (production uses the configured server address). Explain remaining capture/content warnings if any.

Stop only the requested app-owned job with `node --import tsx scripts/narad.ts stop <job-id>`. Never kill unrelated Codex/Claude processes. The server retains sources, completed drafts, reviews, and final lessons locally. A retry creates a new job; it does not resume the old CLI session. This skill does not enable audio or live tutor questions.
