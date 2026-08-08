import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';

/**
 * A connected client's raw `ws` socket, tagged with the bits of state the sync layer
 * needs to track per-connection: a server-issued id (used to skip echoing a client's
 * own update back to itself — see SyncGateway) and which doc it has joined, if any.
 */
export interface LatticeSocket extends WebSocket {
  clientId: string;
  docId?: string;
}

/**
 * Tracks which locally-connected sockets are subscribed to which doc.
 *
 * Purely in-process bookkeeping, formalized out of SyncGateway (SCRUM-28 left it
 * inline) now that RedisFanoutService needs to know "is this the first/last local
 * client for a doc" to decide when to subscribe/unsubscribe from that doc's Redis
 * channel.
 *
 * Ticket: SCRUM-29 (LAT-E1B)
 */
@Injectable()
export class ConnectionRegistryService {
  private readonly docSockets = new Map<string, Set<LatticeSocket>>();

  /** Adds `socket` to `docId`'s set. Returns true if this was the first socket for that doc. */
  add(docId: string, socket: LatticeSocket): boolean {
    let sockets = this.docSockets.get(docId);
    if (!sockets) {
      sockets = new Set();
      this.docSockets.set(docId, sockets);
    }
    const wasEmpty = sockets.size === 0;
    sockets.add(socket);
    return wasEmpty;
  }

  /** Removes `socket` from `docId`'s set. Returns true if the set is now empty. */
  remove(docId: string, socket: LatticeSocket): boolean {
    const sockets = this.docSockets.get(docId);
    if (!sockets) return false;
    sockets.delete(socket);
    const isEmpty = sockets.size === 0;
    if (isEmpty) this.docSockets.delete(docId);
    return isEmpty;
  }

  getSockets(docId: string): ReadonlySet<LatticeSocket> {
    return this.docSockets.get(docId) ?? new Set();
  }
}
