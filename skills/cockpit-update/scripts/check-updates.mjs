import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'mhgd3250905/ugk-cockpit';
const releasesUrl = `https://api.github.com/repos/${repository}/releases?per_page=100`;
const packageRoot = path.resolve(import.meta.dirname, '../../..');

function parseVersion(value) {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null;
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease };
}

function comparePrerelease(left, right) {
  if (left.length === 0) return right.length === 0 ? 0 : 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const a = BigInt(left[index]);
      const b = BigInt(right[index]);
      if (a !== b) return a < b ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(left, right) {
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export async function checkUpdates({ fetchImpl = fetch, timeoutMs = 8000, versionFile = path.join(packageRoot, 'VERSION') } = {}) {
  const currentVersion = readFileSync(versionFile, 'utf8').trim();
  const parsedCurrent = parseVersion(currentVersion);
  if (!parsedCurrent) return { ok: false, code: 'INVALID_LOCAL_VERSION', releasePage: `https://github.com/${repository}/releases` };

  let response;
  try {
    response = await fetchImpl(releasesUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'ugk-cockpit-update-check',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, code: 'NETWORK_UNAVAILABLE', currentVersion, releasePage: `https://github.com/${repository}/releases` };
  }

  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429;
    return {
      ok: false,
      code: limited ? 'GITHUB_RATE_LIMITED' : 'GITHUB_API_UNAVAILABLE',
      currentVersion,
      releasePage: `https://github.com/${repository}/releases`,
    };
  }

  let releases;
  try { releases = await response.json(); }
  catch { return { ok: false, code: 'INVALID_GITHUB_RESPONSE', currentVersion, releasePage: `https://github.com/${repository}/releases` }; }
  if (!Array.isArray(releases)) {
    return { ok: false, code: 'INVALID_GITHUB_RESPONSE', currentVersion, releasePage: `https://github.com/${repository}/releases` };
  }

  const candidates = releases.flatMap((release) => {
    if (release?.draft || typeof release?.tag_name !== 'string') return [];
    const version = release.tag_name.replace(/^v/, '');
    const parsed = parseVersion(version);
    return parsed ? [{ release, version, parsed }] : [];
  });
  candidates.sort((left, right) => compareVersions(right.parsed, left.parsed));
  const latest = candidates[0];
  if (!latest) {
    return { ok: true, currentVersion, latestVersion: null, updateAvailable: false, releasePage: `https://github.com/${repository}/releases` };
  }

  const comparison = compareVersions(parsedCurrent, latest.parsed);
  return {
    ok: true,
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: comparison < 0,
    currentAheadOfRelease: comparison > 0,
    prerelease: Boolean(latest.release.prerelease) || latest.parsed.prerelease.length > 0,
    publishedAt: latest.release.published_at ?? null,
    releaseUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(latest.release.tag_name)}`,
    releasePage: `https://github.com/${repository}/releases`,
    notes: typeof latest.release.body === 'string' ? latest.release.body.slice(0, 6000) : '',
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await checkUpdates();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'LOCAL_VERSION_UNAVAILABLE', releasePage: `https://github.com/${repository}/releases` }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
