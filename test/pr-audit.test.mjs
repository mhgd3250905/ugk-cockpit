import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, FIELDS, parseRepository } from '../skills/cockpit-pr-audit/scripts/pr-audit.mjs';

const pr = (number = 1, overrides = {}) => ({ ...Object.fromEntries(FIELDS.split(',').map(field => [field, null])), number, title: 'Change', url: `https://github.com/team/project/pull/${number}`, headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), isDraft: true, state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SKIPPED' }], reviewDecision: 'REVIEW_REQUIRED', mergeable: 'UNKNOWN', headRepository: { name: 'fork' }, headRepositoryOwner: { login: 'contributor' }, isCrossRepository: true, ...overrides });
function fixture({ branch = 'main', remotes = ['upstream'], tracking = '', data = [pr()], ghError, raw, target = { ref: 'refs/heads/main', object: { type: 'commit', sha: 'c'.repeat(40) } }, targetError } = {}) {
  const calls = [];
  const runner = (program, args, options) => {
    calls.push({ program, args, options });
    if (program === 'gh') {
      if (args[0] === 'api') { if (targetError) throw targetError; return JSON.stringify(typeof target === 'function' ? target() : target); }
      if (ghError) throw ghError;
      return raw ?? JSON.stringify(data);
    }
    if (args[0] === 'rev-parse') return 'C:/project';
    if (args[0] === 'symbolic-ref') { if (branch === null) throw Object.assign(new Error(), { status: 1 }); return branch; }
    if (args[0] === 'check-ref-format') return '';
    if (args[0] === 'config') { if (!tracking) throw Object.assign(new Error(), { status: 1 }); return tracking; }
    if (args.length === 1 && args[0] === 'remote') return remotes.join('\n');
    if (args[0] === 'remote' && args[1] === 'get-url') return 'https://secret:password@github.com/team/project.git';
    throw new Error('Unexpected command');
  };
  return { calls, run: argv => audit(argv, { runner, cwd: 'C:/project', now: () => 'fixed' }) };
}

test('list targets base and explicit repository, preserves fork/draft/unknown checks and bounds commands', () => {
  const f = fixture();
  const result = f.run(['list']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pullRequests, [pr()]);
  assert.equal(result.truncated, false);
  assert.equal(result.repository, 'team/project');
  const gh = f.calls.find(call => call.program === 'gh');
  assert.deepEqual(gh.args.slice(0, 10), ['pr', 'list', '--repo', 'github.com/team/project', '--base', 'main', '--state', 'open', '--limit', '51']);
  for (const { options } of f.calls) {
    assert.equal(options.cwd, 'C:/project');
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0 && options.maxBuffer > 0);
  }
  assert.doesNotMatch(JSON.stringify(result), /secret|password/);
});

test('tracking remote wins, ambiguity requires selection, explicit remote is validated', () => {
  assert.equal(fixture({ remotes: ['origin', 'upstream'], tracking: 'upstream' }).run(['list']).remote, 'upstream');
  const ambiguous = fixture({ remotes: ['origin', 'upstream'] }).run(['list']);
  assert.equal(ambiguous.code, 'REMOTE_REQUIRED');
  assert.deepEqual(ambiguous.candidates, ['origin', 'upstream']);
  assert.equal(fixture().run(['list', '--remote', 'other']).code, 'REMOTE_NOT_FOUND');
  assert.equal(fixture({ remotes: ['origin', 'upstream'] }).run(['list', '--remote', 'origin']).remote, 'origin');
});

test('detached requires explicit base; empty list and truncation are distinct', () => {
  assert.equal(fixture({ branch: null }).run(['list']).code, 'BASE_REQUIRED');
  assert.equal(fixture({ branch: null }).run(['list', '--base', 'main']).ok, true);
  assert.deepEqual(fixture({ data: [] }).run(['list']).pullRequests, []);
  const f = fixture({ data: [pr(1), pr(2)] });
  const result = f.run(['list', '--limit', '1']);
  assert.equal(result.truncated, true);
  assert.equal(result.pullRequests.length, 1);
  assert.equal(f.calls.at(-1).args[9], '2');
  assert.equal(fixture().run(['list', '--limit', '201']).code, 'INVALID_ARGUMENT');
});

test('inspect verifies PR identity, target branch and immutable source/target SHAs', () => {
  const f = fixture({ data: pr() });
  assert.equal(f.run(['inspect', '--pr', '1']).pullRequest.headRefOid, 'a'.repeat(40));
  assert.deepEqual(f.calls.find(call => call.program === 'gh').args.slice(0, 5), ['pr', 'view', '1', '--repo', 'github.com/team/project']);
  for (const overrides of [{ baseRefName: 'other' }, { url: 'https://github.com/other/repo/pull/1' }, { number: 2 }]) {
    assert.equal(fixture({ data: pr(1, overrides) }).run(['inspect', '--pr', '1']).code, 'TARGET_MISMATCH');
  }
  assert.equal(fixture({ data: pr(1, { baseRefOid: null }) }).run(['inspect', '--pr', '1']).code, 'INVALID_RESPONSE');
});

test('inspect reads current target each time, separately from historical PR base, and encodes branch path', () => {
  let sha = 'c'.repeat(40);
  const f = fixture({ data: pr(1, { baseRefName: 'release/next' }), target: () => ({ ref: 'refs/heads/release/next', object: { type: 'commit', sha } }) });
  const first = f.run(['inspect', '--pr', '1', '--base', 'release/next']);
  assert.equal(first.targetHeadOid, sha);
  assert.equal(first.pullRequest.baseRefOid, 'b'.repeat(40));
  assert.deepEqual(f.calls.at(-1).args, ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/team/project/git/ref/heads/release%2Fnext']);
  sha = 'd'.repeat(40);
  assert.equal(f.run(['inspect', '--pr', '1', '--base', 'release/next']).targetHeadOid, sha);
});

test('inspect fails closed when current target cannot be read or verified', () => {
  assert.equal(fixture({ data: pr(), targetError: { status: 1 } }).run(['inspect', '--pr', '1']).ok, false);
  for (const target of [
    { ref: 'refs/heads/other', object: { type: 'commit', sha: 'c'.repeat(40) } },
    { ref: 'refs/heads/main', object: { type: 'tag', sha: 'c'.repeat(40) } },
    { ref: 'refs/heads/main', object: { type: 'commit', sha: 'short' } },
  ]) assert.equal(fixture({ data: pr(), target }).run(['inspect', '--pr', '1']).code, 'TARGET_REF_MISMATCH');
});

test('query errors never become empty results or expose diagnostics', () => {
  for (const [error, code] of [
    [{ status: 4 }, 'AUTHENTICATION_FAILED'], [{ stderr: 'network connection token=secret' }, 'NETWORK_ERROR'],
    [{ code: 'ETIMEDOUT' }, 'COMMAND_TIMEOUT'], [{ code: 'ENOBUFS' }, 'OUTPUT_LIMIT'],
    [{ code: 'ENOENT' }, 'COMMAND_NOT_FOUND'], [{ status: 1 }, 'GITHUB_QUERY_FAILED'],
  ]) {
    const result = fixture({ ghError: Object.assign(new Error('secret'), error) }).run(['list']);
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(fixture({ raw: 'not JSON' }).run(['list']).code, 'INVALID_JSON');
  assert.equal(fixture({ raw: '{}' }).run(['list']).code, 'INVALID_RESPONSE');
});

test('remote parser only accepts github.com HTTPS and SSH without exposing credentials', () => {
  for (const remote of ['https://github.com/team/project.git', 'git@github.com:team/project.git', 'ssh://git@github.com/team/project.git']) assert.equal(parseRepository(remote), 'team/project');
  for (const remote of ['ext::arbitrary command', 'https://other.com/team/project', 'file:///tmp/repo', 'https://github.com/team/project?token=secret']) assert.throws(() => parseRepository(remote), error => error.auditError.code === 'UNSUPPORTED_REMOTE' && !JSON.stringify(error.auditError).includes('secret'));
});

test('linked worktree uses its actual local branch and current project rather than script directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-pr-audit-'));
  const repo = join(root, 'repo');
  const linked = join(root, 'linked');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  try {
    git(['init', '--initial-branch=main', repo]);
    git(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
    git(['-C', repo, 'remote', 'add', 'upstream', 'https://github.com/team/project.git']);
    git(['-C', repo, 'worktree', 'add', '-b', 'release', linked]);
    const calls = [];
    const result = audit(['list'], { cwd: linked, runner(program, args, options) {
      if (program === 'gh') { calls.push(args); return '[]'; }
      return execFileSync(program, args, options);
    } });
    assert.equal(result.ok, true);
    assert.equal(result.branch, 'release');
    assert.equal(result.base, 'release');
    assert.equal(calls[0][5], 'release');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
