import { PresenceRegistryService } from './presence-registry.service';

describe('PresenceRegistryService', () => {
  let registry: PresenceRegistryService;

  beforeEach(() => {
    registry = new PresenceRegistryService();
  });

  describe('add', () => {
    it("returns true for a user's first connection to a doc", () => {
      expect(
        registry.add('doc-1', 'alice', 'alice@example.test', 'client-1'),
      ).toBe(true);
    });

    it('returns false for a second connection from the same user (another tab)', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      expect(
        registry.add('doc-1', 'alice', 'alice@example.test', 'client-2'),
      ).toBe(false);
    });

    it('returns true for a different user joining the same doc', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      expect(registry.add('doc-1', 'bob', 'bob@example.test', 'client-2')).toBe(
        true,
      );
    });

    it("returns true for the same user's first connection to a DIFFERENT doc", () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      expect(
        registry.add('doc-2', 'alice', 'alice@example.test', 'client-2'),
      ).toBe(true);
    });
  });

  describe('remove', () => {
    it('returns false for a connection that was never added', () => {
      expect(registry.remove('doc-1', 'alice', 'client-1')).toBe(false);
    });

    it("returns true when removing a user's only connection to a doc", () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      expect(registry.remove('doc-1', 'alice', 'client-1')).toBe(true);
    });

    it('returns false when a user still has another open tab on the same doc', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-2');
      expect(registry.remove('doc-1', 'alice', 'client-1')).toBe(false);
    });

    it('returns true once the LAST of several open tabs closes', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-2');
      registry.remove('doc-1', 'alice', 'client-1');
      expect(registry.remove('doc-1', 'alice', 'client-2')).toBe(true);
    });

    it('is a no-op removing a clientId that was never added for that user', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      expect(registry.remove('doc-1', 'alice', 'client-does-not-exist')).toBe(
        false,
      );
      expect(registry.list('doc-1')).toEqual([
        { userId: 'alice', email: 'alice@example.test' },
      ]);
    });
  });

  describe('list', () => {
    it('returns an empty array for a doc with no connections', () => {
      expect(registry.list('doc-1')).toEqual([]);
    });

    it('lists a distinct entry per connected user, not per socket', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-2'); // second tab
      registry.add('doc-1', 'bob', 'bob@example.test', 'client-3');

      const presence = registry.list('doc-1');
      expect(presence).toHaveLength(2);
      expect(presence).toEqual(
        expect.arrayContaining([
          { userId: 'alice', email: 'alice@example.test' },
          { userId: 'bob', email: 'bob@example.test' },
        ]),
      );
    });

    it('no longer lists a user after their last connection is removed', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      registry.remove('doc-1', 'alice', 'client-1');
      expect(registry.list('doc-1')).toEqual([]);
    });

    it('keeps docs independent of each other', () => {
      registry.add('doc-1', 'alice', 'alice@example.test', 'client-1');
      registry.add('doc-2', 'bob', 'bob@example.test', 'client-2');

      expect(registry.list('doc-1')).toEqual([
        { userId: 'alice', email: 'alice@example.test' },
      ]);
      expect(registry.list('doc-2')).toEqual([
        { userId: 'bob', email: 'bob@example.test' },
      ]);
    });
  });
});
