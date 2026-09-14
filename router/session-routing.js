'use strict';

function extractSessionId(url = '') {
  const match = url.match(/^\/jcode\/session\/([^/?#]+)(?:[/?#]|$)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return null;
  }
}

function stripProxyPrefix(path = '') {
  const normalized = path
    .replace(/^\/jcode\/session\/[^/?#]+/, '')
    .replace(/^\/session\/[^/?#]+/, '')
    .replace(/^\/jcode/, '');
  if (normalized.startsWith('/proxy/6080')) {
    return normalized.replace(/^\/proxy\/6080/, '') || '/';
  }
  return normalized || '/';
}

function isVncPath(url = '') {
  const normalized = url
    .replace(/^\/jcode\/session\/[^/?#]+/, '')
    .replace(/^\/session\/[^/?#]+/, '')
    .replace(/^\/jcode/, '');
  return normalized.startsWith('/proxy/6080') || normalized.startsWith('/websockify');
}

function routeKeyForProfile(profile) {
  if (profile && profile.jcodeId) return `jcode:${profile.jcodeId}:route`;
  if (!profile || !profile.email || !profile.courseCode || !profile.clss) return null;
  const suffix = profile.snapshot === 'true' || profile.snapshot === true ? ':snapshot' : '';
  return `user:${profile.email}:course:${profile.courseCode}:${profile.clss}${suffix}`;
}

function parseRouteValue(value) {
  if (!value) return null;
  if (/^https?:\/\//.test(value)) {
    return { url: value, status: 'READY', legacy: true };
  }
  try {
    const route = JSON.parse(value);
    if (!route || typeof route.url !== 'string' || !/^https?:\/\//.test(route.url)) return null;
    return route;
  } catch (_) {
    return null;
  }
}

function isRouteCurrent(profile, route, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
  if (!profile || !route || route.status !== 'READY') return false;
  // v2 profiles are never renewed and disappear at their original Redis TTL.
  if ((!profile.routeVersion || profile.routeVersion === '2') && route.legacy === true) return true;
  if (profile.routeVersion !== '3') return false;
  if (route.legacy === true || !profile.revision || !profile.mountHash) return false;
  const expiresAt = Number.parseInt(profile.expiresAt, 10);
  return Number.isFinite(expiresAt)
    && expiresAt > nowEpochSeconds
    && String(route.revision) === String(profile.revision)
    && route.mountHash === profile.mountHash;
}

function profileAccessRequirement(decoded, profile) {
  const { sub, role } = decoded || {};
  const { courseCode, clss, email, viewerEmail, mode, routeVersion } = profile || {};
  if (!sub || !courseCode || !clss || !email) return 'deny';
  if (!routeVersion || routeVersion === '2') {
    if (role === 'ADMIN' || sub === email) return 'allow';
    return 'manager';
  }
  if (routeVersion !== '3' || !viewerEmail || sub !== viewerEmail) return 'deny';
  if (mode !== 'INSPECTOR') return sub === email ? 'allow' : 'deny';
  return role === 'ADMIN' ? 'allow' : 'manager';
}

function metricRoute(path = '') {
  return path
    .replace(/^\/jcode\/session\/[^/]+/, '/jcode/session/:id')
    .replace(/^\/session\/[^/]+/, '/session/:id');
}

module.exports = {
  extractSessionId,
  stripProxyPrefix,
  isVncPath,
  routeKeyForProfile,
  parseRouteValue,
  isRouteCurrent,
  profileAccessRequirement,
  metricRoute,
};
