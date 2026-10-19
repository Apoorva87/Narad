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
