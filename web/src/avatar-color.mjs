/**
 * Small, deterministic helpers for deriving a low-contrast card tint from an
 * already loaded project avatar.  The browser-specific image loading lives in
 * main.jsx; keeping the pixel work here makes the algorithm easy to verify.
 */

export const AVATAR_COLOR_SAMPLE_SIZE = 32;
export const AVATAR_COLOR_BUCKET_SIZE = 32;
export const AVATAR_COLOR_ALPHA_THRESHOLD = 48;
export const AVATAR_COLOR_STRENGTH = 0.12;

export function projectAvatarUrl(project) {
  if (!project?.id || !project?.avatarPath) return null;
  return `/api/v1/projects/${encodeURIComponent(project.id)}/avatar?t=${encodeURIComponent(project.avatarPath)}`;
}

function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampUnit(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeRgb(color) {
  if (!color || typeof color !== 'object') return null;
  const channels = [color.r, color.g, color.b];
  if (!channels.every((channel) => Number.isFinite(channel))) return null;
  return {
    r: clampByte(color.r),
    g: clampByte(color.g),
    b: clampByte(color.b),
  };
}

/**
 * Quantize one channel into a stable bucket. The bucket's average source
 * pixels are returned by extractDominantColor, so this only suppresses small
 * JPEG/WebP noise while preserving the representative hue.
 */
export function quantizeChannel(value, bucketSize = AVATAR_COLOR_BUCKET_SIZE) {
  const size = Number.isFinite(bucketSize) && bucketSize > 0
    ? Math.max(1, Math.round(bucketSize))
    : AVATAR_COLOR_BUCKET_SIZE;
  return Math.min(255, Math.floor(clampByte(value) / size) * size);
}

function bucketKey(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

/**
 * Find the most common visible color in ImageData-like pixels.
 *
 * Pixels whose alpha is at or below alphaThreshold are ignored. Colors are
 * counted in quantized RGB buckets, while the original visible pixels in the
 * winning bucket are averaged for a smoother representative color.
 */
export function extractDominantColor(imageData, {
  bucketSize = AVATAR_COLOR_BUCKET_SIZE,
  alphaThreshold = AVATAR_COLOR_ALPHA_THRESHOLD,
} = {}) {
  const data = imageData?.data;
  if (!data || typeof data.length !== 'number' || data.length < 4) return null;

  const threshold = Number.isFinite(alphaThreshold)
    ? Math.min(255, Math.max(0, alphaThreshold))
    : AVATAR_COLOR_ALPHA_THRESHOLD;
  const buckets = new Map();

  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = Number(data[index + 3]);
    if (!Number.isFinite(alpha) || alpha <= threshold) continue;

    const r = clampByte(data[index]);
    const g = clampByte(data[index + 1]);
    const b = clampByte(data[index + 2]);
    const qr = quantizeChannel(r, bucketSize);
    const qg = quantizeChannel(g, bucketSize);
    const qb = quantizeChannel(b, bucketSize);
    const key = bucketKey(qr, qg, qb);
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.count += 1;
      bucket.sumR += r;
      bucket.sumG += g;
      bucket.sumB += b;
    } else {
      buckets.set(key, {
        count: 1,
        sumR: r,
        sumG: g,
        sumB: b,
      });
    }
  }

  let winner = null;
  for (const bucket of buckets.values()) {
    // Strictly greater keeps the first pixel-scan winner on ties, making the
    // result deterministic without a second expensive sort.
    if (!winner || bucket.count > winner.count) winner = bucket;
  }
  if (!winner) return null;

  return {
    r: Math.round(winner.sumR / winner.count),
    g: Math.round(winner.sumG / winner.count),
    b: Math.round(winner.sumB / winner.count),
  };
}

/**
 * Turn a representative RGB color into a deliberately subtle card tint.
 * The alpha/strength is consumed by CSS color-mix against the active theme's
 * surface-card token, so both light and dark themes remain readable.
 */
export function weakenDominantColor(color, strength = AVATAR_COLOR_STRENGTH) {
  const rgb = normalizeRgb(color);
  if (!rgb) return null;
  return {
    ...rgb,
    strength: clampUnit(strength, AVATAR_COLOR_STRENGTH),
  };
}

export function rgbToCss(color) {
  const rgb = normalizeRgb(color);
  if (!rgb) return null;
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

/**
 * Convert a derived color into the exact class/style contract used by cards.
 * Invalid or missing colors intentionally produce no style, which preserves
 * the existing status/theme background as the fallback.
 */
export function getProjectCardAvatarColorStyle(color) {
  const weakened = weakenDominantColor(color);
  if (!weakened) return { className: '', style: undefined };
  return {
    className: 'has-avatar-color',
    style: {
      '--project-avatar-color': rgbToCss(weakened),
      '--project-avatar-color-strength': `${Math.round(weakened.strength * 100)}%`,
    },
  };
}

/**
 * Draw an image into a tiny canvas and return its ImageData. This helper is
 * defensive by design: unsupported canvas APIs, tainted canvases, malformed
 * images, and missing document objects all resolve to null for fallback use.
 */
export function readSampledImageData(image, {
  documentRef = globalThis.document,
  maxSize = AVATAR_COLOR_SAMPLE_SIZE,
} = {}) {
  try {
    const sourceWidth = Number(image?.naturalWidth || image?.width);
    const sourceHeight = Number(image?.naturalHeight || image?.height);
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
      || sourceWidth <= 0 || sourceHeight <= 0) return null;
    if (!documentRef || typeof documentRef.createElement !== 'function') return null;

    const limit = Number.isFinite(maxSize) && maxSize > 0
      ? Math.max(1, Math.round(maxSize))
      : AVATAR_COLOR_SAMPLE_SIZE;
    const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = documentRef.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || typeof context.drawImage !== 'function'
      || typeof context.getImageData !== 'function') return null;

    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
}

export function extractDominantColorFromImage(image, options = {}) {
  const imageData = readSampledImageData(image, options);
  return imageData ? extractDominantColor(imageData, options) : null;
}
