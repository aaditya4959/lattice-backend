import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

/**
 * SCRUM-58: simulates multiple concurrent clients editing a shared doc and moving
 * cursors on it, to gather real numbers informing SNAPSHOT_INTERVAL_MS
 * (persistence/snapshot-scheduler.service.ts) and CURSOR_THROTTLE_MS
 * (sync/cursor-throttle.service.ts) — both currently placeholder defaults per
 * docs/DESIGN.md §8.
 *
 * `update` messages must be genuinely valid Yjs binary (sync.gateway.ts calls
 * Y.applyUpdate() on them directly — garbage bytes throw), which k6's goja JS runtime
 * can't produce on its own (no real `yjs` package available inside k6 scripts). See
 * ./update-fixtures.json and the generation snippet in ./README.md — ten small
 * pre-baked, genuinely valid single-word insertions, cycled by VUs.
 *
 * Run: see ./README.md for setup (env vars, rate-limit override, how to read results).
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WS_URL = __ENV.WS_URL || 'ws://localhost:3000/sync';
const VUS = Number(__ENV.VUS || 10);
const DOCS = Number(__ENV.DOCS || 3);
const CURSOR_INTERVAL_MS = Number(__ENV.CURSOR_INTERVAL_MS || 30);
const EDIT_INTERVAL_MS = Number(__ENV.EDIT_INTERVAL_MS || 400);
const SESSION_DURATION_S = Number(__ENV.SESSION_DURATION_S || 25);
const PASSWORD = 'correct horse battery';

const updateFixtures = JSON.parse(open('./update-fixtures.json'));

export const options = {
  scenarios: {
    collaborators: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },
};

// Sent-vs-received counters are the actual signal: the gap between cursorsSent and
// cursorsReceived is CURSOR_THROTTLE_MS's real-world suppression ratio; updatesReceived
// vs. the setup's known doc/collaborator layout indicates whether update fan-out kept
// up. Snapshot-write cadence (the SNAPSHOT_INTERVAL_MS side) isn't observable from the
// client at all — that's read directly from Postgres afterward, see README.md.
const cursorsSent = new Counter('cursors_sent');
const cursorsReceived = new Counter('cursors_received');
const updatesSent = new Counter('updates_sent');
const updatesReceived = new Counter('updates_received');

export function setup() {
  const users = [];
  for (let i = 0; i < VUS; i++) {
    const email = `loadtest-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}@example.test`;
    const registerRes = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    check(registerRes, { 'setup: registered': (r) => r.status === 201 });
    const userId = registerRes.json('id');

    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    check(loginRes, { 'setup: logged in': (r) => r.status === 200 });
    const token = loginRes.json('accessToken');

    users.push({ userId, email, token });
  }

  // Round-robin users into DOCS groups sharing one doc each — the first user per
  // group owns it and invites the rest, so every doc gets multiple concurrent
  // editors, not one VU per doc.
  const docIds = [];
  for (let d = 0; d < DOCS; d++) {
    const group = users.filter((_, idx) => idx % DOCS === d);
    const owner = group[0];
    const createRes = http.post(
      `${BASE_URL}/docs`,
      JSON.stringify({ title: `Load test doc ${d}` }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
      },
    );
    check(createRes, { 'setup: doc created': (r) => r.status === 201 });
    const docId = createRes.json('id');

    for (let g = 1; g < group.length; g++) {
      const inviteRes = http.post(
        `${BASE_URL}/docs/${docId}/invite`,
        JSON.stringify({ email: group[g].email }),
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${owner.token}`,
          },
        },
      );
      check(inviteRes, { 'setup: invited': (r) => r.status === 201 });
    }
    docIds.push(docId);
  }

  const sessions = users.map((user, idx) => ({
    ...user,
    docId: docIds[idx % DOCS],
  }));
  // eslint-disable-next-line no-console
  console.log(`setup complete: ${docIds.length} docs — ${docIds.join(', ')}`);
  return { sessions };
}

export default function (data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length];

  const res = ws.connect(WS_URL, {}, function (socket) {
    socket.on('open', function () {
      socket.send(
        JSON.stringify({
          type: 'join',
          docId: session.docId,
          token: session.token,
        }),
      );
    });

    socket.on('message', function (raw) {
      const msg = JSON.parse(raw);
      if (msg.type === 'cursor') cursorsReceived.add(1);
      if (msg.type === 'update') updatesReceived.add(1);
    });

    // Simulates rapid mouse/keyboard-driven cursor movement — real client-side
    // sampling rates for this kind of live indicator are typically in this range.
    socket.setInterval(function () {
      socket.send(
        JSON.stringify({
          type: 'cursor',
          docId: session.docId,
          position: Math.floor(Math.random() * 200),
        }),
      );
      cursorsSent.add(1);
    }, CURSOR_INTERVAL_MS);

    // Simulates a typing cadence — one small edit roughly a few times a second, not
    // one keystroke-per-character (Yjs updates already batch by transaction).
    socket.setInterval(function () {
      const update =
        updateFixtures[Math.floor(Math.random() * updateFixtures.length)];
      socket.send(
        JSON.stringify({ type: 'update', docId: session.docId, update }),
      );
      updatesSent.add(1);
    }, EDIT_INTERVAL_MS);

    socket.setTimeout(function () {
      socket.close();
    }, SESSION_DURATION_S * 1000);
  });

  check(res, { 'connected successfully': (r) => r && r.status === 101 });
}
