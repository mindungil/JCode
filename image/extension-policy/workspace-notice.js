// JCode IDE notices.
//
// Assignment kickoffs and deadlines restart course workspaces and end open IDE
// connections. The Router streams the upcoming transitions of this session's
// course; this script warns the student in advance with a toast styled like the
// JCode portal (react-toastify, top center). Server values are rendered with
// textContent only.
(() => {
  'use strict';

  if (window.top !== window || typeof EventSource !== 'function') return;
  const sessionPath = window.location.pathname.match(/^(.*\/session\/[^/]+)\//);
  if (!sessionPath) return;

  const ENDPOINT = `${sessionPath[1]}/__jcode/notices`;
  const LEAD_MINUTES = { DEADLINE: [10, 5, 1], KICKOFF: [1] };
  const AUTO_CLOSE_MS = 15000;
  const CHECK_INTERVAL_MS = 5000;
  const STORAGE_PREFIX = 'jcode-notice:';
  const FONT = "'JetBrains Mono', 'Noto Sans KR', sans-serif";
  const WARNING_ICON = 'M23.32 17.191L15.438 2.184C14.728.833 13.416 0 11.996 0c-1.42 0-2.733.833-3.443 2.184L.533 17.448a4.744 4.744 0 000 4.368C1.243 23.167 2.555 24 3.975 24h16.05C22.22 24 24 22.044 24 19.632c0-.904-.251-1.746-.68-2.44zm-9.622 1.46c0 1.033-.724 1.823-1.698 1.823s-1.698-.79-1.698-1.822v-.043c0-1.028.724-1.822 1.698-1.822s1.698.79 1.698 1.822v.043zm.039-12.285l-.84 8.06c-.057.581-.408.943-.897.943-.49 0-.84-.367-.896-.942l-.84-8.065c-.057-.624.25-1.095.779-1.095h1.91c.528.005.84.476.784 1.1z';
  const CLOSE_ICON = 'M7.71 8.23l3.75 3.75-1.48 1.48-3.75-3.75-3.75 3.75L1 11.98l3.75-3.75L1 4.48 2.48 3l3.75 3.75L9.98 3l1.48 1.48-3.75 3.75z';

  let transitions = [];
  let offsetMs = 0;
  let container = null;
  const shownInPage = new Set();

  const serverNow = () => Date.now() + offsetMs;

  function alreadyShown(key) {
    if (shownInPage.has(key)) return true;
    try {
      return window.sessionStorage.getItem(STORAGE_PREFIX + key) === '1';
    } catch (_) {
      return false;
    }
  }

  function markShown(key) {
    shownInPage.add(key);
    try {
      window.sessionStorage.setItem(STORAGE_PREFIX + key, '1');
    } catch (_) {
      // Private browsing may reject storage; the in-page set still deduplicates.
    }
  }

  function isDark() {
    const workbench = document.querySelector('.monaco-workbench');
    if (workbench) {
      return workbench.classList.contains('vs-dark') || workbench.classList.contains('hc-black');
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function installStyles() {
    if (document.getElementById('jcode-notice-style')) return;
    const style = document.createElement('style');
    style.id = 'jcode-notice-style';
    style.textContent = `
      .jcode-notice-container{position:fixed;z-index:2147483000;top:max(16px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:1rem;pointer-events:none;box-sizing:border-box}
      .jcode-notice{position:relative;pointer-events:auto;width:320px;max-width:calc(100vw - 32px);min-height:64px;box-sizing:border-box;padding:14px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.1);display:flex;align-items:center;word-break:break-word;font-family:${FONT};font-size:13px;line-height:1.45;overflow:hidden;animation:jcode-notice-in .45s both}
      .jcode-notice--light{background:#fff;color:#757575}
      .jcode-notice--dark{background:#121212;color:#fff}
      .jcode-notice__icon{margin-inline-end:10px;width:22px;flex-shrink:0;display:flex;color:#f1c40f}
      .jcode-notice__icon svg{width:100%;height:100%;fill:currentColor}
      .jcode-notice__body{flex:1 1 auto;padding:0 14px 0 0}
      .jcode-notice__title{display:block;font-weight:700;margin-bottom:2px}
      .jcode-notice__close{position:absolute;top:6px;right:6px;background:transparent;border:none;padding:0;cursor:pointer;opacity:.7;color:#fff;z-index:1}
      .jcode-notice--light .jcode-notice__close{color:#000;opacity:.3}
      .jcode-notice__close:hover,.jcode-notice__close:focus{opacity:1}
      .jcode-notice__close svg{fill:currentColor;height:16px;width:14px}
      .jcode-notice__progress{position:absolute;bottom:0;left:0;width:100%;height:5px;overflow:hidden}
      .jcode-notice__progress-bg{width:100%;height:100%;background:#f1c40f;opacity:.2}
      .jcode-notice__progress-bar{position:absolute;inset:0;background:#f1c40f;opacity:.7;transform-origin:left;animation:jcode-notice-progress linear forwards}
      .jcode-notice:hover .jcode-notice__progress-bar{animation-play-state:paused}
      @keyframes jcode-notice-progress{from{transform:scaleX(1)}to{transform:scaleX(0)}}
      @keyframes jcode-notice-in{from{opacity:0;transform:translate3d(0,-60px,0)}to{opacity:1;transform:none}}
    `;
    document.head.appendChild(style);
  }

  function svg(viewBox, path) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    element.setAttribute('viewBox', viewBox);
    element.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    element.appendChild(shape);
    return element;
  }

  function showToast(title, message, autoClose) {
    installStyles();
    if (!container || !container.isConnected) {
      container = document.createElement('div');
      container.className = 'jcode-notice-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `jcode-notice jcode-notice--${isDark() ? 'dark' : 'light'}`;
    toast.setAttribute('role', 'alert');

    const icon = document.createElement('div');
    icon.className = 'jcode-notice__icon';
    icon.appendChild(svg('0 0 24 24', WARNING_ICON));

    const body = document.createElement('div');
    body.className = 'jcode-notice__body';
    const heading = document.createElement('strong');
    heading.className = 'jcode-notice__title';
    heading.textContent = title;
    const text = document.createElement('span');
    text.textContent = message;
    body.append(heading, text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'jcode-notice__close';
    close.setAttribute('aria-label', '닫기');
    close.appendChild(svg('0 0 14 16', CLOSE_ICON));
    const dismiss = () => toast.remove();
    close.addEventListener('click', dismiss);

    toast.append(icon, body, close);
    if (autoClose) {
      const progress = document.createElement('div');
      progress.className = 'jcode-notice__progress';
      const background = document.createElement('div');
      background.className = 'jcode-notice__progress-bg';
      const bar = document.createElement('div');
      bar.className = 'jcode-notice__progress-bar';
      bar.style.animationDuration = `${AUTO_CLOSE_MS}ms`;
      bar.addEventListener('animationend', dismiss);
      progress.append(background, bar);
      toast.appendChild(progress);
    }
    container.prepend(toast);
  }

  function minutesLabel(remainingMs) {
    const minutes = Math.ceil(remainingMs / 60000);
    return minutes <= 1 ? '1분 이내' : `${minutes}분 후`;
  }

  function notify(transition, lead, remainingMs) {
    const when = minutesLabel(remainingMs);
    const name = transition.assignmentName;
    if (transition.kind === 'DEADLINE') {
      const readOnly = transition.readOnlyAfter
        ? ' 마감 후에는 이 과제를 읽기 전용으로만 볼 수 있습니다.'
        : '';
      showToast(
        `"${name}" 과제가 ${when} 마감됩니다`,
        `마감되면 IDE 연결이 끊기고 환경이 다시 시작됩니다. 작업 중인 파일을 지금 저장하세요.${readOnly} 연결이 끊기면 JCode 포털에서 다시 실행하세요.`,
        lead > 1
      );
    } else {
      showToast(
        `새 과제 "${name}"이(가) ${when} 시작됩니다`,
        '과제가 시작되면 IDE 연결이 끊깁니다. 새 과제 폴더를 연결하려고 환경이 다시 시작될 수 있습니다. 작업 중인 파일을 저장하고, 연결이 끊기면 JCode 포털에서 다시 실행하세요.',
        false
      );
    }
  }

  // Show the closest lead time that has been reached. Checking on an interval
  // (instead of one long timer per notice) keeps throttled background tabs and
  // late page loads correct: a page opened 3 minutes before a deadline shows the
  // 5-minute notice once, then the 1-minute notice.
  function check() {
    const now = serverNow();
    for (const transition of transitions) {
      const remaining = transition.at - now;
      if (remaining <= 0) continue;
      const leads = LEAD_MINUTES[transition.kind] || [];
      const due = leads.filter((lead) => remaining <= lead * 60000);
      if (due.length === 0) continue;
      const lead = Math.min(...due);
      const key = `${transition.id}:${lead}`;
      if (alreadyShown(key)) continue;
      markShown(key);
      notify(transition, lead, remaining);
    }
  }

  function applySchedule(data) {
    if (!data || !Array.isArray(data.transitions) || !Number.isFinite(data.serverTime)) return;
    offsetMs = data.serverTime - Date.now();
    transitions = data.transitions.filter((item) => (
      item && typeof item.id === 'string' && typeof item.assignmentName === 'string' &&
      Number.isFinite(item.at) && LEAD_MINUTES[item.kind]
    ));
    check();
  }

  let retryMs = 5000;
  function connect() {
    const source = new EventSource(ENDPOINT, { withCredentials: true });
    source.addEventListener('schedule', (event) => {
      retryMs = 5000;
      try {
        applySchedule(JSON.parse(event.data));
      } catch (_) {
        // Ignore a malformed message; the next update replaces the schedule.
      }
    });
    source.addEventListener('disabled', () => source.close());
    source.addEventListener('error', () => {
      // EventSource retries network errors itself. A failed HTTP response closes
      // it, so retry with backoff until the session is accepted or disabled.
      if (source.readyState !== EventSource.CLOSED) return;
      window.setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 300000);
    });
  }

  function start() {
    try {
      connect();
      window.setInterval(check, CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    } catch (error) {
      console.warn('JCode notices unavailable:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
