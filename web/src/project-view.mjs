export const PROJECT_VIEW_STORAGE_KEY = 'ugk-cockpit-project-view';

export function normalizeProjectView(value) {
  return value === 'list' ? 'list' : 'cards';
}

export function readProjectView(storage) {
  try {
    const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    return normalizeProjectView(target?.getItem(PROJECT_VIEW_STORAGE_KEY));
  } catch {
    return 'cards';
  }
}

export function saveProjectView(view, storage) {
  try {
    const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    if (!target) return false;
    target.setItem(PROJECT_VIEW_STORAGE_KEY, normalizeProjectView(view));
    return true;
  } catch {
    // Display remains usable when browser storage is unavailable.
    return false;
  }
}
