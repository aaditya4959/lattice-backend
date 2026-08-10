import { Injectable } from '@nestjs/common';
import * as Y from 'yjs';
import { SnapshotService } from '../persistence/snapshot.service';
import { createLatticeDoc } from './doc-schema';

/**
 * In-memory, single-instance cache of live `Y.Doc`s, keyed by `docs.id`. On a cache
 * miss, restores from the doc's latest Postgres snapshot (SCRUM-30) before falling
 * back to an empty doc — so a doc "created" here isn't necessarily new, just newly
 * loaded into this process's memory.
 *
 * `getOrCreate` is async (a cache miss may mean a DB read) and de-duplicates
 * concurrent cold-loads for the same docId via `loading`: without it, two clients
 * joining a never-cached doc at nearly the same time would each independently create
 * and register their own `Y.Doc`, and whichever finished second would silently
 * clobber the first in the map — dropping any updates already applied to the doc the
 * first caller got back, even though both callers believed they held "the" doc.
 * Concurrent callers instead await the same in-flight load and get the same instance.
 *
 * Ticket: SCRUM-30 (LAT-E1B)
 */
@Injectable()
export class DocRegistryService {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly loading = new Map<string, Promise<Y.Doc>>();

  constructor(private readonly snapshots: SnapshotService) {}

  async getOrCreate(docId: string): Promise<Y.Doc> {
    const cached = this.docs.get(docId);
    if (cached) return cached;

    const inFlight = this.loading.get(docId);
    if (inFlight) return inFlight;

    const promise = this.load(docId);
    this.loading.set(docId, promise);
    try {
      const doc = await promise;
      this.docs.set(docId, doc);
      return doc;
    } finally {
      this.loading.delete(docId);
    }
  }

  private async load(docId: string): Promise<Y.Doc> {
    const doc = createLatticeDoc(docId);
    const snapshot = await this.snapshots.getLatest(docId);
    if (snapshot) {
      Y.applyUpdate(doc, snapshot.state);
    }
    return doc;
  }
}
