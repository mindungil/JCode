'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSessionId,
  stripProxyPrefix,
  isVncPath,
  routeKeyForProfile,
  parseRouteValue,
  isRouteCurrent,
  profileAccessRequirement,
  metricRoute,
} = require('./session-routing');

test('extracts a tab-scoped session from HTTP and WebSocket URLs', () => {
  assert.equal(extractSessionId('/jcode/session/a-b-c/?folder=%2Fhome'), 'a-b-c');
  assert.equal(extractSessionId('/jcode/session/a-b-c/stable/ws'), 'a-b-c');
  assert.equal(extractSessionId('/jcode/?id=legacy'), null);
});

test('accepts only a READY route matching the session revision and mount hash', () => {
  const profile = {
    routeVersion: '3',
    revision: '7',
    mountHash: 'abc',
    expiresAt: '200',
  };
  const route = parseRouteValue(JSON.stringify({
    url: 'http://workspace:8080',
    revision: 7,
    mountHash: 'abc',
    status: 'READY',
  }));

  assert.equal(isRouteCurrent(profile, route, 100), true);
  assert.equal(isRouteCurrent({ ...profile, revision: '8' }, route, 100), false);
  assert.equal(isRouteCurrent(profile, { ...route, mountHash: 'def' }, 100), false);
  assert.equal(isRouteCurrent(profile, { ...route, status: 'BLOCKED' }, 100), false);
  assert.equal(isRouteCurrent(profile, route, 200), false);
});

test('legacy URL routes are accepted for existing v2 profiles during migration', () => {
  const route = parseRouteValue('http://workspace:8080');
  assert.equal(isRouteCurrent({}, route, 100), true);
  assert.equal(isRouteCurrent({ routeVersion: '2' }, route, 100), true);
  assert.equal(isRouteCurrent({ routeVersion: '3', expiresAt: '200' }, route, 100), false);
});

test('legacy profiles retain owner and course-manager authorization during migration', () => {
  const profile = { routeVersion: '2', email: 'student@example.com', courseCode: 'os', clss: '1' };
  assert.equal(profileAccessRequirement({ sub: 'student@example.com', role: 'STUDENT' }, profile), 'allow');
  assert.equal(profileAccessRequirement({ sub: 'ta@example.com', role: 'STUDENT' }, profile), 'manager');
  assert.equal(profileAccessRequirement({ sub: 'admin@example.com', role: 'ADMIN' }, profile), 'allow');
});

test('strips only router-owned prefixes before proxying', () => {
  assert.equal(stripProxyPrefix('/jcode/session/a-b-c/stable/file.js'), '/stable/file.js');
  assert.equal(stripProxyPrefix('/session/a-b-c/proxy/6080/vnc.html'), '/vnc.html');
  assert.equal(stripProxyPrefix('/websockify'), '/websockify');
  assert.equal(stripProxyPrefix('/jcode/session/a/proxy/6080/websockify'), '/websockify');
});

test('detects VNC and websockify paths with a session prefix', () => {
  assert.equal(isVncPath('/jcode/session/a/proxy/6080/vnc.html'), true);
  assert.equal(isVncPath('/jcode/session/a/websockify'), true);
  assert.equal(isVncPath('/jcode/session/a/stable/ws'), false);
});

test('uses per-JCode routes and keeps legacy fallback', () => {
  assert.equal(routeKeyForProfile({ jcodeId: '51' }), 'jcode:51:route');
  assert.equal(
    routeKeyForProfile({ email: 'a@example.com', courseCode: 'os', clss: '1', snapshot: 'true' }),
    'user:a@example.com:course:os:1:snapshot'
  );
});

test('binds v3 owner and inspector profiles to the viewer that created them', () => {
  const owner = {
    routeVersion: '3', mode: 'OWNER', viewerEmail: 'student@example.com',
    email: 'student@example.com', courseCode: 'os', clss: '1',
  };
  assert.equal(profileAccessRequirement({ sub: 'student@example.com', role: 'STUDENT' }, owner), 'allow');
  assert.equal(profileAccessRequirement({ sub: 'ta@example.com', role: 'STUDENT' }, owner), 'deny');

  const inspector = {
    ...owner, mode: 'INSPECTOR', viewerEmail: 'ta@example.com',
  };
  assert.equal(profileAccessRequirement({ sub: 'student@example.com', role: 'STUDENT' }, inspector), 'deny');
  assert.equal(profileAccessRequirement({ sub: 'ta@example.com', role: 'STUDENT' }, inspector), 'manager');
  assert.equal(
    profileAccessRequirement({ sub: 'admin@example.com', role: 'ADMIN' }, {
      ...inspector, viewerEmail: 'admin@example.com',
    }),
    'allow'
  );
});

test('normalizes session ids before recording request metrics', () => {
  assert.equal(metricRoute('/jcode/session/secret-a/stable/file.js'), '/jcode/session/:id/stable/file.js');
  assert.equal(metricRoute('/session/secret-b/proxy/6080'), '/session/:id/proxy/6080');
});
