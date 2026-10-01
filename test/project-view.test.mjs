import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_VIEW_STORAGE_KEY,
  normalizeProjectView,
  readProjectView,
  saveProjectView,
} from '../web/src/project-view.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const reads = [];
  const writes = [];
  return {
    values,
    reads,
    writes,
    getItem(key) {
      reads.push(key);
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
}

function withWindow(value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
  try {
    callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  }
}

test('project display preference accepts only cards and list with a cards fallback', () => {
  assert.equal(PROJECT_VIEW_STORAGE_KEY, 'ugk-cockpit-project-view');
  assert.equal(normalizeProjectView('list'), 'list');
  for (const value of ['cards', '', 'grid', 'LIST', null, undefined, false, 1, {}]) {
    assert.equal(normalizeProjectView(value), 'cards');
  }
});

test('project display preference reads saved values and safely normalizes old or invalid data', () => {
  for (const [value, expected] of [['list', 'list'], ['cards', 'cards'], ['invalid', 'cards'], [null, 'cards']]) {
    const storage = memoryStorage({ [PROJECT_VIEW_STORAGE_KEY]: value });
    assert.equal(readProjectView(storage), expected);
    assert.deepEqual(storage.reads, [PROJECT_VIEW_STORAGE_KEY]);
    assert.deepEqual(storage.writes, []);
  }
});

test('project display choice survives a fresh preference read after switching either way', () => {
  const storage = memoryStorage();
  assert.equal(readProjectView(storage), 'cards');
  assert.equal(saveProjectView('list', storage), true);
  assert.equal(readProjectView(storage), 'list');
  assert.equal(saveProjectView('cards', storage), true);
  assert.equal(readProjectView(storage), 'cards');
  assert.equal(saveProjectView('invalid', storage), true);
  assert.equal(readProjectView(storage), 'cards');
  assert.equal(saveProjectView(null, storage), true);
  assert.equal(readProjectView(storage), 'cards');
});

test('project display storage remains independent of theme, client identity and actions', () => {
  const existing = {
    'ugk-cockpit-theme': 'light',
    'ugk-cockpit-client': 'existing-client',
    'ugk-cockpit-action': 'existing-action',
  };
  const storage = memoryStorage(existing);
  assert.equal(saveProjectView('list', storage), true);
  assert.equal(readProjectView(storage), 'list');
  assert.deepEqual(storage.reads, [PROJECT_VIEW_STORAGE_KEY]);
  assert.deepEqual(storage.writes, [[PROJECT_VIEW_STORAGE_KEY, 'list']]);
  assert.deepEqual(Object.fromEntries(storage.values), {
    ...existing,
    [PROJECT_VIEW_STORAGE_KEY]: 'list',
  });
});

test('project display read falls back when the storage method or its getter rejects access', () => {
  const rejectedMethod = { getItem() { throw new Error('storage disabled'); } };
  const rejectedGetter = { get getItem() { throw new Error('storage inaccessible'); } };
  for (const storage of [rejectedMethod, rejectedGetter, {}]) {
    assert.doesNotThrow(() => assert.equal(readProjectView(storage), 'cards'));
  }
});

test('project display save reports failure without throwing when storage rejects writes', () => {
  const rejectedMethod = { setItem() { throw new Error('storage quota exceeded'); } };
  const rejectedGetter = { get setItem() { throw new Error('storage inaccessible'); } };
  for (const storage of [rejectedMethod, rejectedGetter, {}]) {
    assert.doesNotThrow(() => assert.equal(saveProjectView('list', storage), false));
  }
});

test('project display preference uses browser storage when no explicit storage is supplied', () => {
  const storage = memoryStorage({ [PROJECT_VIEW_STORAGE_KEY]: 'list' });
  withWindow({ localStorage: storage }, () => {
    assert.equal(readProjectView(), 'list');
    assert.equal(saveProjectView('cards'), true);
    assert.equal(readProjectView(), 'cards');
  });
  assert.deepEqual(storage.writes, [[PROJECT_VIEW_STORAGE_KEY, 'cards']]);
});

test('project display preference remains usable without browser storage or with a blocked getter', () => {
  for (const browser of [undefined, {}, { get localStorage() { throw new Error('privacy mode'); } }]) {
    withWindow(browser, () => {
      assert.doesNotThrow(() => assert.equal(readProjectView(), 'cards'));
      assert.doesNotThrow(() => assert.equal(saveProjectView('list'), false));
    });
  }
});
