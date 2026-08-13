import { Injectable } from '@nestjs/common';

export interface PresenceUser {
  userId: string;
  email: string;
}

interface PresenceEntry extends PresenceUser {
  clientIds: Set<string>;
}

/**
 * Tracks, per doc, which authenticated *users* are currently connected — not raw
 * sockets (ConnectionRegistryService's job, SCRUM-29). A user open in two tabs on the
 * same doc holds two sockets but is one presence entry: this service dedupes by
 * `userId`, tracking each user's live `clientId`s so a doc's presence list only drops
 * someone once their LAST connection closes, not their first.
 *
 * In-memory, per-instance, same as ConnectionRegistryService — cross-instance merging
 * is a separate concern (SCRUM-47's Redis fan-out), not this service's job.
 *
 * Ticket: SCRUM-45 (LAT-E5)
 */
@Injectable()
export class PresenceRegistryService {
  private readonly docUsers = new Map<string, Map<string, PresenceEntry>>();

  /**
   * Registers a connection for `userId` on `docId`. Returns true if this is the
   * user's first live connection to this doc — a real "user joined" event other
   * clients should be told about, not just another tab from someone already present.
   */
  add(docId: string, userId: string, email: string, clientId: string): boolean {
    let users = this.docUsers.get(docId);
    if (!users) {
      users = new Map();
      this.docUsers.set(docId, users);
    }

    let entry = users.get(userId);
    if (!entry) {
      entry = { userId, email, clientIds: new Set() };
      users.set(userId, entry);
    }
    const isFirstConnection = entry.clientIds.size === 0;
    entry.clientIds.add(clientId);
    return isFirstConnection;
  }

  /**
   * Removes a connection. Returns true if this was the user's last live connection to
   * this doc — a real "user left" event, not just one of several open tabs closing.
   */
  remove(docId: string, userId: string, clientId: string): boolean {
    const users = this.docUsers.get(docId);
    const entry = users?.get(userId);
    if (!users || !entry) return false;

    entry.clientIds.delete(clientId);
    const wasLastConnection = entry.clientIds.size === 0;
    if (wasLastConnection) {
      users.delete(userId);
      if (users.size === 0) this.docUsers.delete(docId);
    }
    return wasLastConnection;
  }

  /** Current presence snapshot for a doc — one entry per distinct connected user. */
  list(docId: string): PresenceUser[] {
    const users = this.docUsers.get(docId);
    if (!users) return [];
    return Array.from(users.values(), ({ userId, email }) => ({
      userId,
      email,
    }));
  }
}
