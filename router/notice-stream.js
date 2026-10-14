'use strict';

// IDE warning notices. The Backend publishes upcoming kickoff/deadline
// transitions per course; open IDE pages receive them over SSE and time the
// toasts locally. Notices carry only the course schedule the student already
// sees in the portal.

const NOTICE_KEY_PREFIX = 'jcode:notices:course:';
const NOTICE_KINDS = new Set(['KICKOFF', 'DEADLINE']);

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
  const { id, assignmentId, assignmentName, kind, at, readOnlyAfter } = value;
  if (typeof id !== 'string' || id.length === 0 || id.length > 120) return null;
  if (typeof assignmentName !== 'string' || assignmentName.length === 0 || assignmentName.length > 100) return null;
  if (!NOTICE_KINDS.has(kind) || !Number.isFinite(at)) return null;
  return {
    id,
    assignmentId: Number.isFinite(assignmentId) ? assignmentId : null,
    assignmentName,
    kind,
    at,
    readOnlyAfter: readOnlyAfter === true,
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

function createNoticeHub({ readValue, profileExists, now = Date.now, logger = console }) {
  const channels = new Map();

  function unsubscribe(client) {
    const channel = channels.get(client.key);
    if (!channel) return;
    channel.clients.delete(client);
    if (channel.clients.size === 0) channels.delete(client.key);
  }

  function close(client) {
    unsubscribe(client);
    try {
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
      current = normalizeNoticeValue(await readValue(client.key));
    } catch (error) {
      logger.error('Notice read failed:', error.message);
    }
    // Only a new channel adopts this value; otherwise the next poll still
    // notices the change and delivers it to the existing subscribers too.
    if (created) channel.last = current;
    client.write(scheduleEvent(current, now()));
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const [key, channel] of channels.entries()) {
        let current;
        try {
          current = normalizeNoticeValue(await readValue(key));
        } catch (error) {
          // A Redis outage must not drop IDE pages; retry on the next poll.
          logger.error('Notice poll failed:', error.message);
          continue;
        }
        const changed = current !== channel.last;
        channel.last = current;
        for (const client of [...channel.clients]) {
          if (client.expiresAtMs <= now()) {
            close(client);
            continue;
          }
          try {
            if (!await profileExists(client.profileKey)) {
              close(client);
              continue;
            }
          } catch (error) {
            logger.error('Notice session check failed:', error.message);
          }
          if (changed) client.write(scheduleEvent(current, now()));
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
  noticeKeyForProfile,
  isNoticeProfile,
  normalizeNoticeValue,
  scheduleEvent,
  createNoticeHub,
};
