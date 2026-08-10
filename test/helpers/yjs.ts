import * as Y from 'yjs';

/**
 * Y.Text.toString() isn't declared on YText in Yjs's shipped .d.ts (see
 * src/sync/yjs.smoke.spec.ts) — same known gap, same suppression, centralized here.
 */
export function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return doc.getText('content').toString();
}
