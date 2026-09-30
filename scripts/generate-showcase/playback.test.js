const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../showcase-videos.js'), 'utf8');

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type) { listeners.get(type)?.forEach(callback => callback()); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}

function page() {
  const videos = Array.from({ length: 5 }, (_, index) => ({
    dataset: { src: `/assets/demo-${index}.mp4` }, src: '', muted: false,
    paused: true, loads: 0, plays: 0,
    getAttribute(name) { return name === 'src' ? this.src || null : null; },
    load() { this.loads++; },
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; },
  }));
  const toggle = { ...events(), textContent: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; } };
  return { videos, toggle,
    querySelectorAll() { return videos; },
    querySelector() { return toggle; },
  };
}

function setup(reducedMotion = false) {
  let main = page();
  let preference = false;
  const subscribers = new Set();
  const observers = [];
  const motion = { ...events(), matches: reducedMotion };
  const document = { ...events(), hidden: false, querySelector() { return main; } };
  const preferences = {
    get() { return preference; },
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(video) { this.observed.add(video); }
    disconnect() { this.observed.clear(); }
    intersect(video, isIntersecting) {
      if (this.observed.has(video)) this.callback([{ target: video, isIntersecting }]);
    }
  }
  const window = { matchMedia() { return motion; }, ffPrefs: preferences, IntersectionObserver: Observer };
  vm.runInNewContext(source, { window, document, ffPrefs: preferences, IntersectionObserver: Observer });
  const view = window.ffViews['how.html'];
  view.mount();
  return { view, main, motion, document, observers, subscribers,
    enter(index) { observers.at(-1).intersect(main.videos[index], true); },
    leave(index) { observers.at(-1).intersect(main.videos[index], false); },
    setPreference(value) {
      preference = value;
      subscribers.forEach(callback => callback('reduceMotion'));
    },
    navigate() { main = page(); this.main = main; view.mount(); },
  };
}

test('off-screen demos have no source until intersection, and leaving pauses playback', () => {
  const app = setup();
  assert.ok(app.main.videos.every(video => video.src === '' && video.loads === 0));
  app.enter(0);
  const first = app.main.videos[0];
  assert.equal(first.src, first.dataset.src);
  assert.equal(first.loads, 1);
  assert.equal(first.paused, false);
  assert.equal(first.muted, true);
  assert.ok(app.main.videos.slice(1).every(video => video.src === '' && video.loads === 0));
  app.leave(0);
  assert.equal(first.paused, true);
  app.enter(0);
  assert.equal(first.paused, false);
  assert.equal(first.loads, 1, 'Returning to a loaded clip must not reload it');
});

test('pause control stops visible demos and resumes only those still on screen', () => {
  const app = setup();
  app.enter(0);
  app.enter(1);
  app.main.toggle.emit('click');
  assert.ok(app.main.videos.every(video => video.paused));
  assert.equal(app.main.toggle.textContent, 'Play demonstrations');
  app.leave(0);
  app.main.toggle.emit('click');
  assert.equal(app.main.videos[0].paused, true);
  assert.equal(app.main.videos[1].paused, false);
  assert.equal(app.main.toggle.textContent, 'Pause demonstrations');
});

test('reduced motion keeps posters until explicit play, including later preference changes', () => {
  const app = setup(true);
  app.enter(2);
  assert.equal(app.main.videos[2].src, '');
  assert.equal(app.main.toggle.textContent, 'Play demonstrations');
  app.main.toggle.emit('click');
  assert.equal(app.main.videos[2].paused, false);
  app.setPreference(true);
  assert.equal(app.main.videos[2].paused, true);
  app.motion.matches = false;
  app.motion.emit('change');
  assert.equal(app.main.videos[2].paused, true, 'The saved preference still reduces motion');
  app.setPreference(false);
  assert.equal(app.main.videos[2].paused, false);
});

test('hidden tabs pause videos and visible tabs resume only intersecting demos', () => {
  const app = setup();
  app.enter(0);
  app.document.hidden = true;
  app.document.emit('visibilitychange');
  assert.equal(app.main.videos[0].paused, true);
  app.document.hidden = false;
  app.document.emit('visibilitychange');
  assert.equal(app.main.videos[0].paused, false);
  assert.ok(app.main.videos.slice(1).every(video => video.src === ''));
});

test('router unmount removes listeners and observers; returning initializes the new page', () => {
  const app = setup();
  const previous = app.main;
  app.enter(0);
  app.view.mount();
  assert.equal(app.observers.length, 1, 'Repeated mount on the same page must be idempotent');
  app.view.unmount();
  assert.ok(previous.videos.every(video => video.paused));
  assert.equal(app.observers[0].observed.size, 0);
  assert.equal(previous.toggle.listenerCount('click'), 0);
  assert.equal(app.motion.listenerCount('change'), 0);
  assert.equal(app.document.listenerCount('visibilitychange'), 0);
  assert.equal(app.subscribers.size, 0);
  app.navigate();
  app.enter(4);
  assert.equal(app.main.videos[4].paused, false);
  assert.equal(app.main.videos[4].loads, 1);
  assert.equal(app.subscribers.size, 1);
  assert.equal(previous.videos[0].paused, true);
});
