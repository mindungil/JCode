'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  noticeKeyForProfile,
  isNoticeProfile,
  normalizeNoticeValue,
  scheduleEvent,
  createNoticeHub,
} = require('./notice-stream');

const owner = {
  routeVersion: '3',
  mode: 'OWNER',
  snapshot: 'false',
  courseCode: 'b2b42635d627',
  clss: '6',
  expiresAt: '200',
};

test('only live owner course sessions receive notices', () => {
  assert.equal(noticeKeyForProfile(owner), 'jcode:notices:course:b2b42635d627:6');
  assert.equal(isNoticeProfile(owner, 100), true);
  assert.equal(isNoticeProfile({ ...owner, expiresAt: '100' }, 100), false);
  assert.equal(isNoticeProfile({ ...owner, mode: 'INSPECTOR' }, 100), false);
  assert.equal(isNoticeProfile({ ...owner, snapshot: 'true' }, 100), false);
  assert.equal(isNoticeProfile({ ...owner, routeVersion: '2' }, 100), false);
  assert.equal(isNoticeProfile({ ...owner, clss: '' }, 100), false);
});

test('notice values are reduced to well-formed transitions', () => {
  const value = JSON.stringify({
    version: 1,
    transitions: [
      { id: '60:DEADLINE:1000', assignmentId: 60, assignmentName: 'hw1', kind: 'DEADLINE', at: 1000, readOnlyAfter: true },
      { id: 'bad', assignmentName: 'x', kind: 'OTHER', at: 1 },
      { id: 'no-time', assignmentName: 'x', kind: 'KICKOFF', at: 'soon' },
      { id: '<script>', assignmentName: '<b>hw</b>', kind: 'KICKOFF', at: 5, extra: 'dropped' },
    ],
  });
  assert.deepEqual(JSON.parse(normalizeNoticeValue(value)), [
    { id: '60:DEADLINE:1000', assignmentId: 60, assignmentName: 'hw1', kind: 'DEADLINE', at: 1000, readOnlyAfter: true, leadMinutes: null },
    { id: '<script>', assignmentId: null, assignmentName: '<b>hw</b>', kind: 'KICKOFF', at: 5, readOnlyAfter: false, leadMinutes: null },
  ]);
  const configured = JSON.parse(normalizeNoticeValue(JSON.stringify({ transitions: [
    { id: 'a', assignmentName: 'hw', kind: 'DEADLINE', at: 1, leadMinutes: [15, 3, 0, 61, 2.5, 'x'] },
  ] })));
  assert.deepEqual(configured[0].leadMinutes, [15, 3]);
  assert.equal(normalizeNoticeValue(null), '[]');
  assert.equal(normalizeNoticeValue('{not json'), '[]');
  assert.equal(scheduleEvent('[]', 7), 'event: schedule\ndata: {"serverTime":7,"transitions":[]}\n\n');
});

function fakeClient(key, overrides = {}) {
  const writes = [];
  const client = {
    key,
    profileKey: 'user:profile:a',
    expiresAtMs: 10_000,
    ended: false,
    writes,
    write: (chunk) => writes.push(chunk),
    end: () => { client.ended = true; },
    ...overrides,
  };
  return client;
}

test('hub sends the current schedule, then only changes, and closes ended sessions', async () => {
  const values = new Map([['k', JSON.stringify({ transitions: [] })]]);
  const sessions = new Set(['user:profile:a']);
  const hub = createNoticeHub({
    readValue: async (key) => values.get(key),
    sessionActive: async (key) => sessions.has(key),
    now: () => 1_000,
    logger: { error() {} },
  });
  const client = fakeClient('k');
  await hub.subscribe(client);
  assert.equal(client.writes.length, 1);
  assert.match(client.writes[0], /"transitions":\[\]/);

  await hub.poll();
  assert.equal(client.writes.length, 1, 'unchanged value is not resent');

  values.set('k', JSON.stringify({
    transitions: [{ id: '1:KICKOFF:5', assignmentId: 1, assignmentName: 'hw', kind: 'KICKOFF', at: 5 }],
  }));
  await hub.poll();
  assert.equal(client.writes.length, 2);
  assert.match(client.writes[1], /"serverTime":1000/);
  assert.match(client.writes[1], /"kind":"KICKOFF"/);

  // A late subscriber must not swallow a change that existing clients have not seen.
  values.delete('k');
  const late = fakeClient('k', { profileKey: 'user:profile:b' });
  sessions.add('user:profile:b');
  await hub.subscribe(late);
  await hub.poll();
  assert.equal(client.writes.length, 3);
  assert.match(client.writes[2], /"transitions":\[\]/);

  sessions.delete('user:profile:a');
  await hub.poll();
  values.set('k', JSON.stringify({ transitions: [] }));
  await hub.poll();
  assert.equal(client.ended, true);
  assert.equal(hub.size(), 1);

  hub.heartbeat();
  assert.equal(late.writes.at(-1), ': ping\n\n');
});

test('hub closes streams at the session expiry and survives Redis errors', async () => {
  let fail = false;
  let current = 5_000;
  const hub = createNoticeHub({
    readValue: async () => {
      if (fail) throw new Error('redis down');
      return null;
    },
    sessionActive: async () => {
      if (fail) throw new Error('redis down');
      return true;
    },
    now: () => current,
    logger: { error() {} },
  });
  const client = fakeClient('k', { expiresAtMs: 6_000 });
  await hub.subscribe(client);
  fail = true;
  await hub.poll();
  assert.equal(client.ended, false, 'a Redis outage keeps the page subscribed');
  current = 6_000;
  await hub.poll();
  assert.equal(client.ended, true, 'expiry is enforced even while Redis is down');
  assert.equal(hub.size(), 0);
});

test('a hanging Redis call does not block later polls', async () => {
  let hang = true;
  const hub = createNoticeHub({
    readValue: async () => (hang ? new Promise(() => {}) : JSON.stringify({ transitions: [] })),
    sessionActive: async () => true,
    now: () => 1_000,
    logger: { error() {} },
    timeoutMs: 20,
  });
  const client = fakeClient('k');
  await hub.subscribe(client);
  await hub.poll();
  hang = false;
  await hub.poll();
  assert.equal(hub.size(), 1);
  assert.equal(client.writes.length, 1, 'unchanged empty schedule is not resent');
});

test('a pending restart is announced once, then the ended session is told why it closed', async () => {
  const values = new Map([['k', JSON.stringify({ transitions: [] })]]);
  let active = true;
  const hub = createNoticeHub({
    readValue: async (key) => values.get(key),
    sessionActive: async () => active,
    now: () => 1_000,
    logger: { error() {} },
  });
  const { restartKeyForProfile } = require('./notice-stream');
  const client = fakeClient('k', { restartKey: restartKeyForProfile({ jcodeId: '912' }) });
  assert.equal(client.restartKey, 'jcode:notices:jcode:912:restart');
  await hub.subscribe(client);
  values.set(client.restartKey, JSON.stringify({ id: '7', reason: 'ASSIGNMENT_CREATED', at: 6_000 }));
  await hub.poll();
  await hub.poll();
  const restarts = client.writes.filter((w) => w.startsWith('event: restart'));
  assert.equal(restarts.length, 1, 'same notice is not repeated');
  assert.match(restarts[0], /"reason":"ASSIGNMENT_CREATED".*"at":6000.*"serverTime":1000/);
  active = false;
  await hub.poll();
  assert.match(client.writes.at(-1), /^event: closed\ndata: \{"reason":"ended"\}/);
  assert.equal(client.ended, true);
});

test('expired sessions get a closed event and non-students get no schedule', async () => {
  const { wantsSchedule, normalizeRestartValue } = require('./notice-stream');
  assert.equal(wantsSchedule({ courseRole: 'STUDENT' }), true);
  assert.equal(wantsSchedule({}), true);
  assert.equal(wantsSchedule({ courseRole: 'PROFESSOR' }), false);
  assert.deepEqual(normalizeRestartValue('{"id":"3","reason":"<x>","at":5}'), { id: '3', reason: 'POLICY_CHANGED', at: 5 });
  assert.equal(normalizeRestartValue('{"id":"3"}'), null);

  let current = 1_000;
  const values = new Map([['k', JSON.stringify({ transitions: [{ id: 'd', assignmentName: 'hw', kind: 'DEADLINE', at: 9 }] })]]);
  const hub = createNoticeHub({ readValue: async (key) => values.get(key), sessionActive: async () => true, now: () => current, logger: { error() {} } });
  const professor = fakeClient('k', { schedule: false, expiresAtMs: 2_000 });
  await hub.subscribe(professor);
  assert.match(professor.writes[0], /"transitions":\[\]/);
  current = 2_000;
  await hub.poll();
  assert.match(professor.writes.at(-1), /"reason":"expired"/);
});
