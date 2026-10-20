# Contextual tutor design

## Goal

Let a learner ask a question at an exact lesson passage, by typing or dictating an editable transcript. Keep the resulting discussion attached to that passage as a persistent message board. The discussion can include constrained teaching diagrams and plots, and participates in narration only while its `Replies` disclosure is expanded.

## Confirmed interaction

- `Ask tutor` pauses lesson narration without losing its position and opens beneath the selected passage.
- A voice question is transcribed into the same editable text field and is never submitted without review.
- The learner chooses `This lesson` for answers constrained to the saved lesson and sources, or `Research further` for web research with citations.
- Each request receives the active block, neighboring blocks, section metadata, source references, lesson familiarity, and earlier turns in that passage thread.
- The UI reports coarse truthful stages, then displays only a complete schema-validated answer.
- Questions and answers are narrated when their thread is expanded. Collapsed threads are omitted from normal lesson playback.
- If help interrupts active playback, the first completed answer is spoken and playback remains stopped afterward. `Continue lesson` resumes from the preserved lesson position.
- Threads are keyed by lesson, mode, section, and block. Generated visuals appear inside the answer and are labeled `Teaching diagram`.

## Data and trust boundaries

Tutor turns live in a small separate SQLite database. This keeps lesson preparation lifecycle changes from coupling to discussion persistence while another feature is evolving. The lesson remains the source of truth for block text and citations.

Agents return a closed JSON schema containing answer blocks: Markdown, equations, references to existing figures, node-edge diagrams, and numeric plots. Narad renders diagrams and plots itself. Agent-authored HTML, JavaScript, and arbitrary SVG are never inserted into the page.

The browser never sends arbitrary text to the speech engine. Tutor speech requests identify a saved turn and whether its question or answer should be spoken; the server retrieves and validates the text before synthesis.

## Failure and cancellation

The learner's question is saved before an agent starts. A stopped or failed turn remains in the thread with its status and can be removed or retried. Only one tutor request runs at a time in the first version. Preparation jobs may continue independently.

Browser speech recognition is used for dictation where supported. Its transcript is always editable, and typing remains available when the browser does not expose recognition.

