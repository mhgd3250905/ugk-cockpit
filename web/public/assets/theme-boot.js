(function () {
  var STORAGE_KEY = 'ugk-cockpit-theme';
  var MODES = ['light', 'dark', 'system'];
  var THEME_COLORS = {
    dark: '#191b20',
    light: '#f4f5f7',
  };
  var mode = 'dark';

  try {
    var stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (MODES.indexOf(stored) !== -1) {
      mode = stored;
    }
  } catch (error) {
    // Fall back to default dark mode when storage is unavailable or throws.
    mode = 'dark';
  }

  var query = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function resolve() {
    if (mode === 'system') {
      return query && query.matches ? 'dark' : 'light';
    }
    return mode === 'light' ? 'light' : 'dark';
  }

  function syncThemeColor(theme) {
    if (typeof document === 'undefined') return;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      if (document.head) {
        document.head.appendChild(meta);
      }
    }
    meta.content = THEME_COLORS[theme] || THEME_COLORS.dark;
  }

  function apply() {
    var theme = resolve();
    if (typeof document !== 'undefined' && document.documentElement) {
      var root = document.documentElement;
      root.dataset.theme = theme;
      // Appica UI / Tailwind components key off the `.dark` / `.light` class.
      root.classList.toggle('dark', theme === 'dark');
      root.classList.toggle('light', theme === 'light');
      root.style.colorScheme = theme;
      syncThemeColor(theme);
    }
  }

  function onChange() {
    if (mode !== 'system') return;
    apply();
  }

  if (query) {
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange);
    }
  }

  if (typeof window !== 'undefined') {
    window.__ugkSetTheme = function (next) {
      if (MODES.indexOf(next) === -1) return;
      mode = next;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_KEY, next);
        }
      } catch (error) {
        // The choice stays in memory when storage is unavailable.
      }
      apply();
    };

    window.__ugkGetThemeMode = function () {
      return mode;
    };

  }

  apply();
})();
