import * as Y from 'yjs';

/**
 * Schema for how a Lattice document maps onto a Yjs `Y.Doc`.
 *
 * v1 scope is intentionally narrow, per docs/DESIGN.md §2 (Non-Goals: "Rich media
 * embeds... plain/rich text only"): a Lattice doc is a single shared `Y.Text` field,
 * nothing else — no `Y.Map`/`Y.Array`/`Y.XmlFragment` structures yet. If/when rich
 * text or multi-field docs are needed, extend this schema deliberately rather than
 * bolting extra shared types onto docs that predate them.
 *
 * Doc identity: a Lattice doc's Postgres identity (`docs.id`, see DESIGN.md §5) is
 * carried into Yjs via `Y.Doc`'s `guid` option, so `doc.guid` is always inspectable
 * and traceable back to `docs.id` (useful for logging/debugging). This is a label,
 * not a lookup mechanism — Yjs doesn't use `guid` to resolve top-level docs (it's
 * meaningful for Yjs's subdocuments feature, which this project doesn't use). The
 * authoritative `docId -> Y.Doc` mapping is owned by whichever piece holds the
 * in-memory doc registry (the connection registry / sync gateway work, LAT-E1B).
 *
 * Ticket: SCRUM-27 (LAT-E1B)
 */

/** The single shared-type key every Lattice `Y.Doc` uses for its text content. */
export const LATTICE_TEXT_KEY = 'content';

/**
 * Creates a new `Y.Doc` for a Lattice document, tagged with its Postgres `docs.id` as
 * the Yjs `guid`, and eagerly initializes the schema's one `Y.Text` field so callers
 * never need to know the shared-type key directly.
 */
export function createLatticeDoc(docId: string): Y.Doc {
  const doc = new Y.Doc({ guid: docId });
  doc.getText(LATTICE_TEXT_KEY);
  return doc;
}

/** Returns the shared `Y.Text` field for a Lattice doc, per the schema above. */
export function getLatticeText(doc: Y.Doc): Y.Text {
  return doc.getText(LATTICE_TEXT_KEY);
}
