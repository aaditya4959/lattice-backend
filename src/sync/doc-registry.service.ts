import { Injectable } from '@nestjs/common';
import * as Y from 'yjs';
import { createLatticeDoc } from './doc-schema';

/**
 * In-memory, single-instance cache of live `Y.Doc`s, keyed by `docs.id`.
 *
 * This is intentionally minimal for SCRUM-28: a doc created here exists only for the
 * lifetime of this process, and only this process's connected clients see it. It has
 * no persistence (SCRUM-30 adds Postgres snapshotting) and no cross-instance awareness
 * (SCRUM-29 adds Redis fan-out so multiple server instances converge on the same doc).
 *
 * Ticket: SCRUM-28 (LAT-E1B)
 */
@Injectable()
export class DocRegistryService {
  private readonly docs = new Map<string, Y.Doc>();

  /** Returns the live `Y.Doc` for `docId`, creating and caching one if none exists yet. */
  getOrCreate(docId: string): Y.Doc {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = createLatticeDoc(docId);
      this.docs.set(docId, doc);
    }
    return doc;
  }
}
