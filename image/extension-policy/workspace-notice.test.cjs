'use strict';
// Behaviour tests for workspace-notice.js. Not part of the image build; run with
// jsdom available, e.g. `npm install --no-save jsdom@24 && node --test workspace-notice.test.cjs`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(process.env.NOTICE_SCRIPT || require('node:path').join(__dirname, 'workspace-notice.js'), 'utf8');

function setup({ path = '/jcode/session/abc-123/', now = 1_000_000 } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div class="monaco-workbench vs-dark"></div></body></html>', {
    url: `https://jcode.example${path}?workspace=%2Fhome`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let clock = now;
  const timers = [];
  const sources = [];
  window.Date.now = () => clock;
  window.setInterval = (fn) => { timers.push(fn); return timers.length; };
  window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  class FakeEventSource {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = 1;
      this.listeners = {};
      sources.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, data) { (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) })); }
    close() { this.readyState = 2; }
  }
  FakeEventSource.CLOSED = 2;
  window.EventSource = FakeEventSource;
  let closed = 0;
  window.close = () => { closed += 1; };
  window.eval(SCRIPT);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return {
    window,
    sources,
    closedCount: () => closed,
    runTimeouts(ms) { clock += ms; timers.filter((t) => typeof t === 'object').splice(0).forEach((t) => t.fn()); },
    overlay: () => window.document.querySelector('.jcode-session-ended')?.textContent || null,
    tick(ms) {
      clock += ms;
      timers.filter((t) => typeof t === 'function').forEach((fn) => fn());
    },
    toasts() {
      return [...window.document.querySelectorAll('.jcode-notice')].map((toast) => ({
        title: toast.querySelector('.jcode-notice__title').textContent,
        text: toast.querySelector('.jcode-notice__body span').textContent,
        dark: toast.classList.contains('jcode-notice--dark'),
        progress: Boolean(toast.querySelector('.jcode-notice__progress-bar')),
      }));
    },
  };
}

const minute = 60_000;

test('connects to the session notice stream only inside an IDE session page', () => {
  const page = setup();
  assert.equal(page.sources.length, 1);
  assert.equal(page.sources[0].url, '/jcode/session/abc-123/__jcode/notices');
  assert.equal(page.sources[0].options.withCredentials, true);
  assert.equal(setup({ path: '/jcode/' }).sources.length, 0);
});

test('deadline warnings fire at 10, 5 and 1 minutes once each, using server time', () => {
  const page = setup();
  const serverTime = 5_000_000; // server clock is ahead of the browser
  page.sources[0].emit('schedule', {
    serverTime,
    transitions: [{ id: '60:DEADLINE:x', assignmentName: 'hw1', kind: 'DEADLINE', at: serverTime + 11 * minute, readOnlyAfter: true }],
  });
  assert.equal(page.toasts().length, 0);
  page.tick(1 * minute);
  assert.equal(page.toasts().length, 1);
  assert.equal(page.toasts()[0].title, '"hw1" 과제가 10분 후 마감됩니다');
  assert.match(page.toasts()[0].text, /읽기 전용/);
  assert.equal(page.toasts()[0].dark, true);
  assert.equal(page.toasts()[0].progress, true);
  page.tick(10_000);
  assert.equal(page.toasts().length, 1, 'same lead is not repeated');
  page.tick(5 * minute - 10_000);
  assert.equal(page.toasts()[0].title, '"hw1" 과제가 5분 후 마감됩니다');
  page.tick(4 * minute);
  const last = page.toasts()[0];
  assert.equal(last.title, '"hw1" 과제가 1분 이내 마감됩니다');
  assert.equal(last.progress, false, 'final warning stays until dismissed');
  assert.equal(page.toasts().length, 3);
  page.tick(2 * minute);
  assert.equal(page.toasts().length, 0, 'warnings are retracted once the deadline passed');
});

test('a page opened 3 minutes before a deadline shows the 5-minute warning once', () => {
  const page = setup();
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'a', assignmentName: 'hw2', kind: 'DEADLINE', at: 1_000_000 + 3 * minute, readOnlyAfter: false }],
  });
  assert.equal(page.toasts().length, 1);
  assert.equal(page.toasts()[0].title, '"hw2" 과제가 3분 후 마감됩니다');
  assert.doesNotMatch(page.toasts()[0].text, /읽기 전용/);
});

test('kickoff warns one minute ahead and reloads do not repeat a shown warning', () => {
  const page = setup();
  const schedule = {
    serverTime: 1_000_000,
    transitions: [{ id: 'k', assignmentName: 'hw3', kind: 'KICKOFF', at: 1_000_000 + 50_000 }],
  };
  page.sources[0].emit('schedule', schedule);
  assert.equal(page.toasts().length, 1);
  assert.equal(page.toasts()[0].title, '새 과제 "hw3"이(가) 1분 이내 시작됩니다');
  // The same page receiving the schedule again (router change push) does not duplicate.
  page.sources[0].emit('schedule', schedule);
  assert.equal(page.toasts().length, 1);
  assert.equal(page.window.sessionStorage.getItem('jcode-notice:k:1'), '1');
});

test('a moved deadline cancels pending warnings', () => {
  const page = setup();
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'old', assignmentName: 'hw4', kind: 'DEADLINE', at: 1_000_000 + 12 * minute }],
  });
  page.sources[0].emit('schedule', { serverTime: 1_000_000, transitions: [] });
  page.tick(5 * minute);
  assert.equal(page.toasts().length, 0);
});

test('assignment names are rendered as text, not HTML', () => {
  const page = setup();
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'x', assignmentName: '<img src=x onerror=alert(1)>', kind: 'DEADLINE', at: 1_000_000 + minute }],
  });
  assert.equal(page.window.document.querySelectorAll('img').length, 0);
  assert.match(page.toasts()[0].title, /<img src=x/);
});

test('disabled sessions stop, failed HTTP responses retry with backoff', () => {
  const page = setup();
  page.sources[0].emit('disabled', {});
  assert.equal(page.sources[0].readyState, 2);
  const other = setup();
  other.sources[0].readyState = 2;
  other.sources[0].emit('error', {});
  assert.equal(other.sources.length, 1, 'retry is scheduled, not immediate');
});

test('close button removes the toast', () => {
  const page = setup();
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'c', assignmentName: 'hw5', kind: 'DEADLINE', at: 1_000_000 + minute }],
  });
  page.window.document.querySelector('.jcode-notice__close').click();
  assert.equal(page.toasts().length, 0);
});

test('an extended deadline retracts the sticky one-minute warning', () => {
  const page = setup();
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'd:1', assignmentName: 'hw6', kind: 'DEADLINE', at: 1_000_000 + 40_000 }],
  });
  assert.equal(page.toasts().length, 1);
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'd:2', assignmentName: 'hw6', kind: 'DEADLINE', at: 1_000_000 + 30 * minute }],
  });
  assert.equal(page.toasts().length, 0);
});

test('warnings are taken back once the transition has passed', () => {
  const page = setup();
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'k:1', assignmentName: 'hw7', kind: 'KICKOFF', at: 1_000_000 + 30_000 }],
  });
  assert.equal(page.toasts().length, 1);
  page.tick(31_000);
  assert.equal(page.toasts().length, 0);
});

test('an older Router without the stream stops reconnecting until the page is shown again', () => {
  const page = setup();
  const timeouts = [];
  page.window.setTimeout = (fn) => { timeouts.push(fn); return timeouts.length; };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const source = page.sources.at(-1);
    source.readyState = 2;
    source.emit('error', {});
    const retry = timeouts.shift();
    if (!retry) break;
    retry();
  }
  assert.equal(page.sources.length, 6, 'gives up after six failed connections');
  Object.defineProperty(page.window.document, 'visibilityState', { value: 'visible', configurable: true });
  page.window.document.dispatchEvent(new page.window.Event('visibilitychange'));
  assert.equal(page.sources.length, 7, 'reconnects when the student returns to the page');
});

test('warning times sent by the Backend replace the built-in defaults', () => {
  const page = setup();
  page.sources[0].emit('schedule', {
    serverTime: 1_000_000,
    transitions: [{ id: 'c:1', assignmentName: 'hw8', kind: 'DEADLINE', at: 1_000_000 + 20 * minute, leadMinutes: [15, 3] }],
  });
  assert.equal(page.toasts().length, 0);
  page.tick(5 * minute);
  assert.equal(page.toasts()[0].title, '"hw8" 과제가 15분 후 마감됩니다');
  assert.equal(page.toasts()[0].progress, true);
  page.tick(12 * minute);
  assert.equal(page.toasts()[0].title, '"hw8" 과제가 3분 후 마감됩니다');
  assert.equal(page.toasts()[0].progress, false, 'the last configured warning stays on screen');
});

test('a restart notice counts down, then closes the IDE with a message', () => {
  const page = setup();
  page.sources[0].emit('restart', { id: '9', reason: 'ASSIGNMENT_CREATED', at: 1_000_000 + 5000, serverTime: 1_000_000 });
  assert.equal(page.toasts()[0].title, '새 과제가 등록되었습니다');
  assert.match(page.toasts()[0].text, /5초 후 IDE가 닫힙니다/);
  page.runTimeouts(5100);
  for (let i = 0; i < 3; i += 1) page.runTimeouts(300);
  assert.match(page.overlay(), /새 과제가 등록되었습니다/);
  assert.equal(page.closedCount() >= 1, true);
  // A repeated delivery of the same notice does nothing more.
  page.sources[0].emit('restart', { id: '9', reason: 'ASSIGNMENT_CREATED', at: 1_000_000 + 5000, serverTime: 1_000_000 });
  assert.equal(page.window.document.querySelectorAll('.jcode-session-ended').length, 1);
});

test('a session ended by the router closes after five seconds with the reason', () => {
  const page = setup();
  page.sources[0].emit('closed', { reason: 'expired' });
  assert.match(page.overlay(), /IDE 사용 시간이 끝났습니다/);
  assert.match(page.overlay(), /5초 후 이 창이 닫힙니다/);
  assert.equal(page.closedCount(), 0);
  for (let i = 0; i < 25; i += 1) page.runTimeouts(250);
  assert.equal(page.closedCount() >= 1, true);
  assert.equal(page.sources[0].readyState, 2, 'notice stream stops');
});

test('toasts wrap at word boundaries in a wider box', () => {
  const page = setup();
  page.sources[0].emit('schedule', { serverTime: 1_000_000, transitions: [{ id: 'w', assignmentName: 'hw', kind: 'DEADLINE', at: 1_000_000 + 60_000 }] });
  const css = page.window.document.getElementById('jcode-notice-style').textContent;
  assert.match(css, /width:400px/);
  assert.match(css, /word-break:keep-all/);
});
