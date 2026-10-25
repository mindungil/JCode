'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sessionKind,
  socketMetricLabels,
  summarizeSockets,
  openSessions,
} = require('./socket-metrics');

test('classifies inspector, snapshot and standard sessions', () => {
  assert.equal(sessionKind({ mode: 'INSPECTOR', snapshot: 'true' }), 'inspector');
  assert.equal(sessionKind({ snapshot: 'true' }), 'snapshot');
  assert.equal(sessionKind({ snapshot: true }), 'snapshot');
  assert.equal(sessionKind({ mode: 'STUDENT' }), 'standard');
  assert.equal(sessionKind(), 'standard');
});

test('keeps email out of labels but uses it for distinct users', () => {
  const labels = socketMetricLabels({ courseCode: '64', clss: '1', email: 'a@jbnu.ac.kr' });
  assert.deepEqual(labels, { courseCode: '64', clss: '1', kind: 'standard', user: 'a@jbnu.ac.kr' });
  assert.deepEqual(socketMetricLabels({}), { courseCode: 'unknown', clss: 'unknown', kind: 'standard', user: null });
  assert.equal(socketMetricLabels({ courseCode: '64', clss: '1', email: 's@x', viewerEmail: 'prof@x', mode: 'INSPECTOR' }).user, 'prof@x');
});

test('counts sockets and distinct users per course, class and kind', () => {
  const s = (profile) => ({ metrics: socketMetricLabels(profile) });
  const result = summarizeSockets([
    s({ courseCode: '64', clss: '1', email: 'a@x' }),
    s({ courseCode: '64', clss: '1', email: 'a@x' }),
    s({ courseCode: '64', clss: '1', email: 'b@x' }),
    s({ courseCode: '64', clss: '2', email: 'a@x' }),
    s({ courseCode: '64', clss: '1', email: 'a@x', viewerEmail: 'p@x', mode: 'INSPECTOR' }),
    s({ courseCode: '64', clss: '1', email: 'b@x', viewerEmail: 'p@x', mode: 'INSPECTOR' }),
    {},
    null,
  ]);
  const byKey = Object.fromEntries(result.map((r) => [`${r.labels.course_code}/${r.labels.clss}/${r.labels.kind}`, r]));
  assert.equal(result.length, 3);
  assert.deepEqual(byKey['64/1/standard'], { labels: { course_code: '64', clss: '1', kind: 'standard' }, sockets: 3, users: 2 });
  assert.deepEqual(byKey['64/2/standard'], { labels: { course_code: '64', clss: '2', kind: 'standard' }, sockets: 1, users: 1 });
  assert.deepEqual(byKey['64/1/inspector'], { labels: { course_code: '64', clss: '1', kind: 'inspector' }, sockets: 2, users: 1 });
});

test('returns nothing when no sockets are open', () => {
  assert.deepEqual(summarizeSockets([]), []);
});

test('skips destroyed and half-closed sockets', () => {
  const open = { destroyed: false, readableEnded: false };
  const closed = { destroyed: true, readableEnded: false };
  const halfClosed = { destroyed: false, readableEnded: true };
  const sessions = openSessions(new Map([[open, { id: 1 }], [closed, { id: 2 }], [halfClosed, { id: 3 }]]));
  assert.deepEqual(sessions, [{ id: 1 }]);
});
