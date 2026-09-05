import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVATAR_COLOR_ALPHA_THRESHOLD,
  AVATAR_COLOR_BUCKET_SIZE,
  AVATAR_COLOR_STRENGTH,
  extractDominantColor,
  extractDominantColorFromImage,
  getProjectCardAvatarColorStyle,
  projectAvatarUrl,
  quantizeChannel,
  readSampledImageData,
  weakenDominantColor,
} from '../web/src/avatar-color.mjs';

function imageDataFromPixels(pixels) {
  return { data: Uint8ClampedArray.from(pixels.flat()) };
}

test('dominant color uses quantized RGB buckets and keeps a representative average', () => {
  const imageData = imageDataFromPixels([
    [241, 35, 39, 255],
    [247, 42, 45, 255],
    [245, 39, 43, 255],
    [38, 88, 172, 255],
  ]);

  assert.equal(quantizeChannel(247, AVATAR_COLOR_BUCKET_SIZE), 224);
  assert.deepEqual(extractDominantColor(imageData), { r: 244, g: 39, b: 42 });
});

test('dominant color ignores fully and highly transparent pixels', () => {
  const imageData = imageDataFromPixels([
    [12, 210, 110, AVATAR_COLOR_ALPHA_THRESHOLD],
    [12, 210, 110, 0],
    [35, 72, 190, 255],
    [35, 72, 190, 220],
  ]);

  assert.deepEqual(extractDominantColor(imageData), { r: 35, g: 72, b: 190 });
  assert.equal(extractDominantColor({ data: new Uint8ClampedArray([1, 2, 3, 1]) }), null);
});

test('weakening returns a bounded low-intrusion strength and card style contract', () => {
  const weakened = weakenDominantColor({ r: 20, g: 120, b: 220 });
  assert.deepEqual(weakened, { r: 20, g: 120, b: 220, strength: AVATAR_COLOR_STRENGTH });
  assert.deepEqual(getProjectCardAvatarColorStyle(weakened), {
    className: 'has-avatar-color',
    style: {
      '--project-avatar-color': 'rgb(20 120 220)',
      '--project-avatar-color-strength': '12%',
    },
  });
  assert.deepEqual(getProjectCardAvatarColorStyle(null), {
    className: '',
    style: undefined,
  });
});

test('canvas sampling is small, same-image only, and fails closed when unavailable', () => {
  const drawCalls = [];
  const context = {
    drawImage: (...args) => drawCalls.push(args),
    getImageData: (x, y, width, height) => ({
      data: Uint8ClampedArray.from([200, 20, 20, 255]),
      width,
      height,
    }),
  };
  const documentRef = {
    createElement: (tag) => {
      assert.equal(tag, 'canvas');
      return { getContext: () => context };
    },
  };
  const image = { naturalWidth: 640, naturalHeight: 320 };
  const sampled = readSampledImageData(image, { documentRef });

  assert.equal(sampled.width, 32);
  assert.equal(sampled.height, 16);
  assert.deepEqual(drawCalls[0], [image, 0, 0, 32, 16]);
  assert.deepEqual(extractDominantColorFromImage(image, { documentRef }), { r: 200, g: 20, b: 20 });
  assert.equal(readSampledImageData(image, { documentRef: null }), null);
});

test('project card avatar URL binds the project identity and saved avatar path', () => {
  assert.equal(
    projectAvatarUrl({ id: 'project/one', avatarPath: 'project/one/file.png' }),
    '/api/v1/projects/project%2Fone/avatar?path=project%2Fone%2Ffile.png',
  );
  assert.equal(projectAvatarUrl({ id: 'project-one', avatarPath: '' }), null);
});
