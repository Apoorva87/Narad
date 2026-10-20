# Jalapeño learning modes implementation plan

**Goal:** Deliver actual quick-summary, detailed tutor walkthrough, and host–expert dialogue for the saved Jalapeño source, accessible from its library entry.

**Architecture:** Prepare original teaching material against stable source-section/unit IDs. Compile it into the existing versioned lesson contract, retain captured visuals via validated local asset references, and link the source collection to the prepared lesson. Persist the generated artifact locally. This implements the example lesson now; automatic generation for arbitrary new sources and narration remain unfinished.

**Spec:** ../specs/2026-10-19-narad-design.md

## Tasks

- [x] Author source-grounded explanations and spoken scripts in independent content files for foundations, architecture, and design. Preserve section order, all figures, numeric facts, and qualifications; avoid copied source prose.
- [x] Extend lesson validation for local captured assets and source-collection association; test missing assets and dangling links.
- [x] Compile three modes, check source-unit/figure coverage and numerical coverage, and review the teaching quality.
- [x] Make the source entry open its lesson when ready and provide explicit source/lesson navigation.
- [x] Verify actual Jalapeño modes in desktop/mobile browser, save the lesson, and report exact remaining limitations.

## Review focus

Source estimates and speculative topology must not become established facts. Units and formulas must retain their meaning. Dialogue needs genuinely spoken explanations. Source images must remain available in both detailed modes. No fake generate/playback controls.
