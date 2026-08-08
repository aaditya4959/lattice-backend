import * as Y from 'yjs';

describe('Yjs smoke test', () => {
  it('constructs a Y.Doc and reads back inserted text', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'hello lattice');
    // Y.Text.toString() is a real, documented API for reading plain text content, but
    // Yjs's shipped .d.ts doesn't declare it on YText, so the type checker falls back
    // to Object's toString signature — hence the lint suppression, not a real risk.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(text.toString()).toBe('hello lattice');
  });

  it('replicates state to a second doc via encodeStateAsUpdate/applyUpdate', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    docA.getText('content').insert(0, 'hello');
    const update = Y.encodeStateAsUpdate(docA);
    Y.applyUpdate(docB, update);

    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(docB.getText('content').toString()).toBe('hello');
  });
});
