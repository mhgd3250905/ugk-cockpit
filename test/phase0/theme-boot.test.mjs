import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const THEME_BOOT_PATH = path.resolve('web/public/assets/theme-boot.js');
const THEME_BOOT_CODE = readFileSync(THEME_BOOT_PATH, 'utf8');

function createMockEnvironment({
  stored = null,
  throwOnGet = false,
  throwOnSet = false,
  prefersDark = true,
  hasMetaTag = true,
  initialMetaColor = '#14120f',
} = {}) {
  let mediaQueryListener = null;
  const storageMap = new Map();
  if (stored !== null) {
    storageMap.set('ugk-cockpit-theme', stored);
  }

  const classList = new Set();
  const documentElement = {
    dataset: {},
    style: {},
    classList: {
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classList.has(name) : Boolean(force);
        if (shouldAdd) classList.add(name);
        else classList.delete(name);
        return shouldAdd;
      },
      add: (name) => classList.add(name),
      remove: (name) => classList.delete(name),
      contains: (name) => classList.has(name),
    },
    setAttribute(key, value) {
      if (key === 'data-theme') this.dataset.theme = value;
    },
  };

  const headChildren = [];
  if (hasMetaTag) {
    headChildren.push({
      name: 'theme-color',
      content: initialMetaColor,
    });
  }

  const document = {
    documentElement,
    head: {
      appendChild(node) {
        headChildren.push(node);
        return node;
      },
    },
    querySelector(selector) {
      if (selector === 'meta[name="theme-color"]') {
        return headChildren.find((el) => el.name === 'theme-color') || null;
      }
      return null;
    },
    createElement(tagName) {
      if (tagName === 'meta') {
        return { name: '', content: '' };
      }
      return {};
    },
  };

  const matchMediaQuery = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener(event, callback) {
      if (event === 'change') mediaQueryListener = callback;
    },
    removeEventListener() {},
    addListener(callback) {
      mediaQueryListener = callback;
    },
    removeListener() {},
  };

  const localStorage = {
    getItem(key) {
      if (throwOnGet) throw new Error('SecurityError: LocalStorage is disabled');
      return storageMap.has(key) ? storageMap.get(key) : null;
    },
    setItem(key, value) {
      if (throwOnSet) throw new Error('QuotaExceededError');
      storageMap.set(key, String(value));
    },
  };

  const window = {
    matchMedia: (query) => matchMediaQuery,
    localStorage,
    document,
  };

  const context = vm.createContext({
    window,
    document,
    localStorage,
    console,
  });

  return {
    context,
    window,
    document,
    storageMap,
    triggerSystemChange: (newPrefersDark) => {
      matchMediaQuery.matches = newPrefersDark;
      if (mediaQueryListener) {
        mediaQueryListener({ matches: newPrefersDark, media: '(prefers-color-scheme: dark)' });
      }
    },
  };
}

function runThemeBoot(env) {
  vm.runInContext(THEME_BOOT_CODE, env.context);
}

test('theme boot defaults to dark mode when localStorage has no saved theme', () => {
  const env = createMockEnvironment({ stored: null });
  runThemeBoot(env);

  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.document.documentElement.style.colorScheme, 'dark');
  assert.equal(env.document.documentElement.classList.contains('dark'), true);
  assert.equal(env.document.documentElement.classList.contains('light'), false);
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#14120f');
});

test('theme boot applies stored light theme on boot', () => {
  const env = createMockEnvironment({ stored: 'light' });
  runThemeBoot(env);

  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.document.documentElement.style.colorScheme, 'light');
  assert.equal(env.document.documentElement.classList.contains('light'), true);
  assert.equal(env.document.documentElement.classList.contains('dark'), false);
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#f5f2ec');
});

test('theme boot applies stored dark theme on boot', () => {
  const env = createMockEnvironment({ stored: 'dark' });
  runThemeBoot(env);

  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.document.documentElement.style.colorScheme, 'dark');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#14120f');
});

test('theme boot resolves stored system mode with prefers-color-scheme', () => {
  const envDark = createMockEnvironment({ stored: 'system', prefersDark: true });
  runThemeBoot(envDark);
  assert.equal(envDark.document.documentElement.dataset.theme, 'dark');
  assert.equal(envDark.document.documentElement.style.colorScheme, 'dark');
  assert.equal(envDark.document.querySelector('meta[name="theme-color"]').content, '#14120f');

  const envLight = createMockEnvironment({ stored: 'system', prefersDark: false });
  runThemeBoot(envLight);
  assert.equal(envLight.document.documentElement.dataset.theme, 'light');
  assert.equal(envLight.document.documentElement.style.colorScheme, 'light');
  assert.equal(envLight.document.querySelector('meta[name="theme-color"]').content, '#f5f2ec');
});

test('theme boot falls back to dark mode when stored value is invalid', () => {
  for (const invalidValue of ['invalid', 'blue', '', 'true', 'null', 'undefined']) {
    const env = createMockEnvironment({ stored: invalidValue });
    runThemeBoot(env);

    assert.equal(env.document.documentElement.dataset.theme, 'dark');
    assert.equal(env.document.documentElement.style.colorScheme, 'dark');
    assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#14120f');
  }
});

test('theme boot falls back to dark mode when localStorage read throws', () => {
  const env = createMockEnvironment({ throwOnGet: true });
  assert.doesNotThrow(() => runThemeBoot(env));

  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.document.documentElement.style.colorScheme, 'dark');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#14120f');
});

test('__ugkSetTheme persists manual choice and updates DOM attributes and theme-color', () => {
  const env = createMockEnvironment({ stored: null });
  runThemeBoot(env);

  env.window.__ugkSetTheme('light');
  assert.equal(env.storageMap.get('ugk-cockpit-theme'), 'light');
  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.document.documentElement.style.colorScheme, 'light');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#f5f2ec');

  env.window.__ugkSetTheme('dark');
  assert.equal(env.storageMap.get('ugk-cockpit-theme'), 'dark');
  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.document.documentElement.style.colorScheme, 'dark');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#14120f');
});

test('__ugkSetTheme ignores invalid values and retains current theme', () => {
  const env = createMockEnvironment({ stored: 'light' });
  runThemeBoot(env);

  env.window.__ugkSetTheme('invalid-theme');
  assert.equal(env.storageMap.get('ugk-cockpit-theme'), 'light');
  assert.equal(env.document.documentElement.dataset.theme, 'light');
});

test('__ugkSetTheme handles storage write failure gracefully without throwing', () => {
  const env = createMockEnvironment({ stored: null, throwOnSet: true });
  runThemeBoot(env);

  assert.doesNotThrow(() => env.window.__ugkSetTheme('light'));
  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.document.documentElement.style.colorScheme, 'light');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#f5f2ec');
});

test('system mode dynamically responds to prefers-color-scheme changes', () => {
  const env = createMockEnvironment({ stored: 'system', prefersDark: false });
  runThemeBoot(env);

  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#f5f2ec');

  env.triggerSystemChange(true);
  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.document.documentElement.style.colorScheme, 'dark');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#14120f');

  env.triggerSystemChange(false);
  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.document.documentElement.style.colorScheme, 'light');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#f5f2ec');
});

test('manual mode does not change active theme when prefers-color-scheme changes', () => {
  const env = createMockEnvironment({ stored: 'light', prefersDark: false });
  runThemeBoot(env);

  assert.equal(env.document.documentElement.dataset.theme, 'light');
  env.triggerSystemChange(true);
  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#f5f2ec');

  env.window.__ugkSetTheme('dark');
  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  env.triggerSystemChange(false);
  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.document.querySelector('meta[name="theme-color"]').content, '#14120f');
});

test('theme boot creates and appends theme-color meta tag if not present in document head', () => {
  const env = createMockEnvironment({ stored: 'dark', hasMetaTag: false });
  runThemeBoot(env);

  const meta = env.document.querySelector('meta[name="theme-color"]');
  assert.ok(meta);
  assert.equal(meta.content, '#14120f');
});

test('index.html contains single theme-color meta tag and references theme-boot.js', () => {
  const indexHtml = readFileSync(path.resolve('web/index.html'), 'utf8');
  const themeColorMatches = indexHtml.match(/<meta[^>]*name=["']theme-color["'][^>]*>/g) || [];
  assert.equal(themeColorMatches.length, 1, 'There should be exactly one theme-color meta tag');
  assert.doesNotMatch(themeColorMatches[0], /media=/i, 'theme-color tag should not have media attribute');
  assert.match(indexHtml, /<script[^>]*src=["']\/assets\/theme-boot\.js["'][^>]*><\/script>/);
});
