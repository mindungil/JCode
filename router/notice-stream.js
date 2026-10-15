'use strict';

// IDE warning notices. The Backend publishes upcoming kickoff/deadline
// transitions per course; open IDE pages receive them over SSE and time the
// toasts locally. Notices carry only the course schedule the student already
// sees in the portal.

const NOTICE_KEY_PREFIX = 'jcode:notices:course:';
const NOTICE_KINDS = new Set(['KICKOFF', 'DEADLINE']);
const REASON_PATTERN = /^[A-Z_]{1,40}$/;

// Written by the Backend when a policy change is about to restart this JCode.
function restartKeyForProfile(profile) {
  return profile && /^[0-9]+$/.test(String(profile.jcodeId || '')) ? `jcode:notices:jcode:${profile.jcodeId}:restart` : null;
}

// Schedule warnings concern students only; other course roles are not restarted
// by kickoffs and deadlines. Profiles without a role predate the field.
function wantsSchedule(profile) {
  return !profile || !profile.courseRole || profile.courseRole === 'STUDENT';
}

function normalizeRestartValue(value) {
  if (!value) return null;
  try {
    const { id, reason, at } = JSON.parse(value) || {};
    if (typeof id !== 'string' || id.length === 0 || id.length > 40 || !Number.isFinite(at)) return null;
    return { id, reason: REASON_PATTERN.test(reason || '') ? reason : 'POLICY_CHANGED', at };
  } catch (_) {
    return null;
  }
}

function noticeKeyForProfile(profile) {
  if (!profile || !profile.courseCode || !profile.clss) return null;
  return `${NOTICE_KEY_PREFIX}${profile.courseCode}:${profile.clss}`;
}

// Inspector and snapshot sessions are not restarted by student schedule
// transitions, so only the owner's own course session receives notices.
function isNoticeProfile(profile, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
  if (!profile || profile.routeVersion !== '3') return false;
  if (profile.mode !== 'OWNER' || profile.snapshot === 'true') return false;
  const expiresAt = Number.parseInt(profile.expiresAt, 10);
  return Number.isFinite(expiresAt) && expiresAt > nowEpochSeconds && noticeKeyForProfile(profile) !== null;
}

function normalizeTransition(value) {
  if (!value || typeof value !== 'object') return null;
  const { id, assignmentId, assignmentName, kind, at, readOnlyAfter, leadMinutes } = value;
  if (typeof id !== 'string' || id.length === 0 || id.length > 120) return null;
  if (typeof assignmentName !== 'string' || assignmentName.length === 0 || assignmentName.length > 100) return null;
  if (!NOTICE_KINDS.has(kind) || !Number.isFinite(at)) return null;
  const leads = Array.isArray(leadMinutes)
    ? leadMinutes.filter((lead) => Number.isInteger(lead) && lead >= 1 && lead <= 60).slice(0, 5)
    : [];
  return {
    id,
    assignmentId: Number.isFinite(assignmentId) ? assignmentId : null,
    assignmentName,
    kind,
    at,
    readOnlyAfter: readOnlyAfter === true,
    // Configured by the Backend; the IDE falls back to its defaults when absent.
    leadMinutes: leads.length > 0 ? leads : null,
  };
}

// Returns the canonical JSON of the transition list; missing or malformed
// values become an empty list so stale toasts are cancelled.
function normalizeNoticeValue(value) {
  if (!value) return '[]';
  try {
    const parsed = JSON.parse(value);
    const transitions = Array.isArray(parsed && parsed.transitions) ? parsed.transitions : [];
    return JSON.stringify(transitions.map(normalizeTransition).filter(Boolean).slice(0, 50));
  } catch (_) {
    return '[]';
  }
}

function scheduleEvent(transitionsJson, serverTime) {
  return `event: schedule\ndata: {"serverTime":${Number(serverTime)},"transitions":${transitionsJson}}\n\n`;
}

function restartEvent(notice, serverTime) {
  return `event: restart\ndata: ${JSON.stringify({ ...notice, serverTime: Number(serverTime) })}\n\n`;
}

function closedEvent(reason) {
  return `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// sessionActive(profileKey) resolves false once the launch profile is gone or its
// route is no longer current (a policy bump ended this IDE session).
function createNoticeHub({ readValue, sessionActive, now = Date.now, logger = console, timeoutMs = 3000 }) {
  const channels = new Map();

  function unsubscribe(client) {
    const channel = channels.get(client.key);
    if (!channel) return;
    channel.clients.delete(client);
    if (channel.clients.size === 0) channels.delete(client.key);
  }

  // The page shows why the IDE stopped instead of reconnecting forever.
  function close(client, reason) {
    unsubscribe(client);
    try {
      if (reason) client.write(closedEvent(reason));
      client.end();
    } catch (_) {
      // The connection may already be gone.
    }
  }

  async function subscribe(client) {
    let channel = channels.get(client.key);
    const created = !channel;
    if (created) {
      channel = { clients: new Set(), last: null };
      channels.set(client.key, channel);
    }
    channel.clients.add(client);
    let current = '[]';
    try {
      current = normalizeNoticeValue(await withTimeout(readValue(client.key), timeoutMs));
    } catch (error) {
      logger.error('Notice read failed:', error.message);
    }
    // Only a new channel adopts this value; otherwise the next poll still
    // notices the change and delivers it to the existing subscribers too.
    if (created) channel.last = current;
    client.write(scheduleEvent(client.schedule === false ? '[]' : current, now()));
    await deliverRestart(client);
  }

  async function deliverRestart(client, value) {
    if (!client.restartKey) return;
    let notice = null;
    try {
      notice = normalizeRestartValue(value !== undefined ? value : await withTimeout(readValue(client.restartKey), timeoutMs));
    } catch (error) {
      logger.error('Restart notice read failed:', error.message);
      return;
    }
    if (!notice || notice.id === client.lastRestartId) return;
    client.lastRestartId = notice.id;
    client.write(restartEvent(notice, now()));
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const [key, channel] of [...channels.entries()]) {
        // Expiry needs no Redis, so it is enforced even during an outage.
        for (const client of [...channel.clients]) {
          if (client.expiresAtMs <= now()) close(client, 'expired');
        }
        if (channel.clients.size === 0) continue;
        const clients = [...channel.clients];
        const [active, restarts] = await Promise.all([
          Promise.all(clients.map((client) => (
            withTimeout(sessionActive(client.profileKey), timeoutMs).catch((error) => {
              logger.error('Notice session check failed:', error.message);
              return true;
            })
          ))),
          Promise.all(clients.map((client) => (
            client.restartKey
              ? withTimeout(readValue(client.restartKey), timeoutMs).catch(() => null)
              : null
          ))),
        ]);
        for (const [index, client] of clients.entries()) {
          // A pending restart is announced before the session ends.
          await deliverRestart(client, restarts[index]);
          if (!active[index]) close(client, 'ended');
        }
        if (channel.clients.size === 0) continue;
        let current;
        try {
          current = normalizeNoticeValue(await withTimeout(readValue(key), timeoutMs));
        } catch (error) {
          // A Redis outage must not drop IDE pages; retry on the next poll.
          logger.error('Notice poll failed:', error.message);
          continue;
        }
        if (current === channel.last) continue;
        channel.last = current;
        const event = scheduleEvent(current, now());
        for (const client of channel.clients) {
          if (client.schedule !== false) client.write(event);
        }
      }
    } finally {
      polling = false;
    }
  }

  function heartbeat() {
    for (const channel of channels.values()) {
      for (const client of channel.clients) client.write(': ping\n\n');
    }
  }

  function size() {
    let count = 0;
    for (const channel of channels.values()) count += channel.clients.size;
    return count;
  }

  return { subscribe, unsubscribe, poll, heartbeat, size };
}

module.exports = {
  restartKeyForProfile,
  wantsSchedule,
  normalizeRestartValue,
  noticeKeyForProfile,
  isNoticeProfile,
  normalizeNoticeValue,
  scheduleEvent,
  createNoticeHub,
};
