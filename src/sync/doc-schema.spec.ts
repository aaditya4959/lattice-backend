import * as Y from 'yjs';
import {
  LATTICE_TEXT_KEY,
  createLatticeDoc,
  getLatticeText,
} from './doc-schema';

describe('doc-schema', () => {
  it('tags the created Y.Doc with the given docId as its guid', () => {
    const doc = createLatticeDoc('doc-123');
    expect(doc.guid).toBe('doc-123');
  });

  it('initializes the single Y.Text field under LATTICE_TEXT_KEY', () => {
    const doc = createLatticeDoc('doc-123');
    expect(getLatticeText(doc)).toBeInstanceOf(Y.Text);
  });

  it('getLatticeText reads through the same shared type as a raw doc.getText call', () => {
    const doc = createLatticeDoc('doc-123');
    getLatticeText(doc).insert(0, 'hello');
    // Y.Text.toString() isn't declared on YText in Yjs's shipped .d.ts (see
    // src/sync/yjs.smoke.spec.ts) — same known gap, same suppression.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(doc.getText(LATTICE_TEXT_KEY).toString()).toBe('hello');
  });

  it('gives distinct guids to docs created for different docIds', () => {
    const docA = createLatticeDoc('doc-a');
    const docB = createLatticeDoc('doc-b');
    expect(docA.guid).not.toBe(docB.guid);
  });
});
