'use strict';

// 열린 IDE WebSocket을 강의(courseCode·clss)와 세션 종류별로 센다.
// 이메일·학번은 Prometheus 라벨에 넣지 않고, 사용자 수를 셀 때만 메모리에서 쓴다.

function sessionKind(profile = {}) {
  if (profile.mode === 'INSPECTOR') return 'inspector';
  if (profile.snapshot === 'true' || profile.snapshot === true) return 'snapshot';
  return 'standard';
}

function socketMetricLabels(profile = {}) {
  return {
    courseCode: String(profile.courseCode || 'unknown'),
    clss: String(profile.clss || 'unknown'),
    kind: sessionKind(profile),
    // 조회(inspector) 세션은 보는 사람(viewerEmail)을 센다. 본인 세션은 viewerEmail과 email이 같다.
    user: profile.viewerEmail || profile.email ? String(profile.viewerEmail || profile.email) : null,
  };
}

// sessions: activeSockets 값들 중 아직 열려 있는 것. 각 값의 metrics는 socketMetricLabels 결과다.
function summarizeSockets(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const metrics = session && session.metrics;
    if (!metrics) continue;
    const key = [metrics.courseCode, metrics.clss, metrics.kind].join('\u0000');
    let group = groups.get(key);
    if (!group) {
      group = {
        labels: { course_code: metrics.courseCode, clss: metrics.clss, kind: metrics.kind },
        sockets: 0,
        users: new Set(),
      };
      groups.set(key, group);
    }
    group.sockets += 1;
    if (metrics.user) group.users.add(metrics.user);
  }
  return [...groups.values()].map(({ labels, sockets, users }) => ({
    labels,
    sockets,
    users: users.size,
  }));
}

// 브라우저 쪽이 끊고(FIN) IDE 쪽이 아직 닫지 않은 반쯤 열린 연결은 세지 않는다.
function openSessions(activeSockets) {
  const sessions = [];
  for (const [socket, session] of activeSockets) {
    if (!socket.destroyed && !socket.readableEnded) sessions.push(session);
  }
  return sessions;
}

module.exports = {
  sessionKind,
  socketMetricLabels,
  summarizeSockets,
  openSessions,
};
