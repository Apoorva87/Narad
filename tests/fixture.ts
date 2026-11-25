export function minimalLesson(): any {
  return {
    version: 1, id: 'fixture', title: 'A lesson', description: 'A small test lesson.',
    topic: 'Mathematics', createdAt: '2026-10-19T12:00:00.000Z', isSample: false,
    familiarity: 'foundational',
    sources: [{ id: 'source-1', title: 'Original notes', kind: 'note', content: 'An exact statement.', locators: ['section-1'] }],
    assets: [],
    modes: { walkthrough: { title: 'Detailed walkthrough', sections: [
      { id: 'first', title: 'First', blocks: [{ id: 'block-a', kind: 'text', markdown: 'An exact statement.', spokenText: 'An exact statement.', references: [{ sourceId: 'source-1', locator: 'section-1' }], origin: 'source' }] },
      { id: 'second', title: 'Second', blocks: [{ id: 'block-b', kind: 'equation', latex: 'x = 2', markdown: 'Here, x equals two.', spokenText: 'Here, x equals two.', references: [], origin: 'teaching' }] },
    ] } },
  };
}

/** Course material every authored section now carries; tests about other behaviour add it through `withCourse`. */
export const courseMaterial = () => ({ objective: 'Explain what the delay measures.', takeaway: 'A delay is elapsed time between two events.', diagram: null,
  checks: [{ question: 'What does the delay measure?', questionSpoken: 'What does the delay measure?', options: ['Elapsed time', 'Distance', 'Mass'], answer: 0, explanation: 'A delay is elapsed time.', explanationSpoken: 'A delay is elapsed time.' }] });
/** Wraps a fake agent so its authored sections include slides and course material unless the test supplied its own. */
export function withCourse<A extends unknown[]>(run: (request: any, ...rest: A) => Promise<unknown>) {
  const add = (teaching: any) => teaching && Array.isArray(teaching.units) ? { ...teaching, units: teaching.units.map((unit: any) => ({ slide: '- Key point', ...unit })), course: teaching.course ?? courseMaterial() } : teaching;
  return async (request: any, ...rest: A) => {
    const output: any = await run(request, ...rest);
    if (request.kind !== 'author' || !output || typeof output !== 'object') return output;
    return Array.isArray(output.results) ? { ...output, results: output.results.map((result: any) => ({ ...result, teaching: add(result.teaching) })) } : add(output);
  };
}
