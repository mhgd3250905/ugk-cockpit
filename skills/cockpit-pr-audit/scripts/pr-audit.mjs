#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FIELDS = 'number,title,url,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,state,statusCheckRollup,reviewDecision,mergeable,mergeStateStatus,updatedAt,headRepository,headRepositoryOwner,isCrossRepository';
const impact = '项目代码和 Git 状态未被修改。';
function fail(code, message, requiredAction, extra = {}) {
  throw Object.assign(new Error(message), { auditError: { ok: false, code, message, impact, requiredAction, ...extra } });
}

export function parseRepository(value) {
  let host, path;
  const scp = /^git@([^:]+):(.+)$/.exec(value);
  if (scp) [, host, path] = scp;
  else {
    try {
      const url = new URL(value);
      if (!['https:', 'ssh:'].includes(url.protocol) || url.search || url.hash || url.port) throw new Error();
      host = url.hostname;
      path = url.pathname.replace(/^\//, '');
    } catch { fail('UNSUPPORTED_REMOTE', '所选代码位置不是支持的 GitHub 地址。', '请选择 github.com 的 HTTPS 或 SSH remote。'); }
  }
  if (host.toLowerCase() !== 'github.com' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) {
    fail('UNSUPPORTED_REMOTE', '所选代码位置不是支持的 GitHub 地址。', '请选择 github.com 的 HTTPS 或 SSH remote。');
  }
  return path.replace(/\.git$/, '');
}

function options(argv) {
  const [command, ...rest] = argv;
  if (!['list', 'inspect'].includes(command)) fail('INVALID_ARGUMENT', '需要 list 或 inspect 子命令。', '使用 list，或 inspect --pr NUMBER。');
  const result = { command, limit: 50 };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, '');
    const value = rest[i + 1];
    if (!['remote', 'base', 'limit', 'pr'].includes(name) || rest[i] !== `--${name}` || !value || value.startsWith('--') || seen.has(name)) {
      fail('INVALID_ARGUMENT', '参数无效或重复。', '使用 --remote NAME、--base BRANCH、list --limit N 或 inspect --pr NUMBER。');
    }
    seen.add(name);
    result[name] = value;
  }
  if ((command === 'inspect' && (!/^\d+$/.test(result.pr ?? '') || Number(result.pr) < 1 || !Number.isSafeInteger(Number(result.pr)) || seen.has('limit'))) ||
      (command === 'list' && (seen.has('pr') || !/^\d+$/.test(String(result.limit)) || Number(result.limit) < 1 || Number(result.limit) > 200))) {
    fail('INVALID_ARGUMENT', 'PR 编号或列表上限无效。', 'inspect 需要正整数 --pr；list 的 --limit 为 1 到 200。');
  }
  result.limit = Number(result.limit);
  return result;
}

// The injected runner has execFileSync's signature; no shell or remote helper is used.
export function audit(argv, { cwd = process.cwd(), runner = execFileSync, now = () => new Date().toISOString() } = {}) {
  try {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { ok: true, usage: ['node pr-audit.mjs list [--remote NAME] [--base BRANCH] [--limit 1..200]', 'node pr-audit.mjs inspect --pr NUMBER [--remote NAME] [--base BRANCH]'], description: '从当前项目目录只读查询 github.com；默认目标为当前本地分支。无需初始化 Cockpit。' };
    const opts = options(argv);
    function run(program, args, allowMissing = false) {
      try {
        return String(runner(program, args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
      } catch (error) {
        if (allowMissing && error.status === 1 && !error.signal && !error.code) return '';
        const diagnostic = String(error.stderr ?? '');
        const code = error.code === 'ETIMEDOUT' ? 'COMMAND_TIMEOUT' : error.code === 'ENOBUFS' ? 'OUTPUT_LIMIT' : error.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' :
          program === 'gh' && (error.status === 4 || /authentication|not logged|gh auth login|HTTP 401|HTTP 403/i.test(diagnostic)) ? 'AUTHENTICATION_FAILED' :
          program === 'gh' && /network|connection|resolve host|TLS|timeout|dial tcp/i.test(diagnostic) ? 'NETWORK_ERROR' : program === 'gh' ? 'GITHUB_QUERY_FAILED' : 'GIT_QUERY_FAILED';
        fail(code, `${program} 只读查询未完成。`, code === 'AUTHENTICATION_FAILED' ? '检查 GitHub CLI 登录状态及仓库读取权限，然后重试。' : '检查 Git/gh 安装、网络及当前目录后重试；不要将失败视为没有 PR。');
      }
    }
    run('git', ['rev-parse', '--show-toplevel']);
    const branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], true) || null;
    if (!branch && !opts.base) fail('BASE_REQUIRED', '当前工作副本没有检出的本地分支。', '通过 --base BRANCH 明确目标分支。');
    const base = opts.base ?? branch;
    run('git', ['check-ref-format', '--branch', base]);
    const remotes = run('git', ['remote']).split(/\r?\n/).filter(Boolean);
    let remote = opts.remote;
    if (remote && !remotes.includes(remote)) fail('REMOTE_NOT_FOUND', '指定的 remote 不属于当前项目。', '从候选中选择 --remote NAME。', { candidates: remotes });
    if (!remote && branch) remote = run('git', ['config', '--get', `branch.${branch}.remote`], true) || undefined;
    if (remote && !remotes.includes(remote)) fail('TRACKING_REMOTE_UNAVAILABLE', '当前分支的跟踪位置不是可用 remote。', '通过 --remote NAME 明确选择代码位置。', { candidates: remotes });
    if (!remote) {
      if (remotes.length !== 1) fail('REMOTE_REQUIRED', '无法唯一确定项目的 GitHub 代码位置。', '通过 --remote NAME 明确选择代码位置。', { candidates: remotes });
      [remote] = remotes;
    }
    const repository = parseRepository(run('git', ['remote', 'get-url', '--', remote]));
    const args = opts.command === 'list'
      ? ['pr', 'list', '--repo', `github.com/${repository}`, '--base', base, '--state', 'open', '--limit', String(opts.limit + 1), '--json', FIELDS]
      : ['pr', 'view', opts.pr, '--repo', `github.com/${repository}`, '--json', FIELDS];
    let data;
    try { data = JSON.parse(run('gh', args)); }
    catch (error) { if (error.auditError) throw error; fail('INVALID_JSON', 'GitHub CLI 返回了无法解析的数据。', '检查 gh 版本后重试。'); }
    const entries = opts.command === 'list' ? data : [data];
    if (!Array.isArray(entries)) fail('INVALID_RESPONSE', 'GitHub 返回的数据结构不完整。', '检查 gh 版本后重试。');
    for (const pr of entries) {
      if (!pr || !Number.isSafeInteger(pr.number) || !FIELDS.split(',').every(field => Object.hasOwn(pr, field)) ||
          !/^[0-9a-f]{40}$/i.test(pr.headRefOid) || !/^[0-9a-f]{40}$/i.test(pr.baseRefOid)) {
        fail('INVALID_RESPONSE', 'PR 数据不完整，无法确认源和目标提交。', '重新查询，确认 PR 的源与目标提交均可读取。');
      }
      const expectedUrl = `https://github.com/${repository}/pull/${pr.number}`;
      if (pr.baseRefName !== base || pr.url.toLowerCase() !== expectedUrl.toLowerCase() || (opts.command === 'inspect' && pr.number !== Number(opts.pr)) || (opts.command === 'list' && pr.state !== 'OPEN')) {
        fail('TARGET_MISMATCH', '返回的 PR 与所选目标仓库、分支或编号不一致。', '检查 --remote、--base 和 --pr；不要将该结果作为可审阅 PR。');
      }
    }
    const context = { ok: true, repository, remote, branch, base, queriedAt: now() };
    if (opts.command === 'inspect') {
      let target;
      try {
        target = JSON.parse(run('gh', ['api', '--hostname', 'github.com', '--method', 'GET', `repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`]));
      } catch (error) {
        if (error.auditError) throw error;
        fail('INVALID_JSON', 'GitHub CLI 返回了无法解析的目标分支数据。', '重新查询目标分支；不要使用 PR 的历史目标提交代替当前版本。');
      }
      if (target?.ref !== `refs/heads/${base}` || target?.object?.type !== 'commit' || !/^[0-9a-f]{40}$/i.test(target?.object?.sha ?? '')) {
        fail('TARGET_REF_MISMATCH', '无法确认当前远端目标分支的提交。', '检查目标分支是否存在并重新查询；不要使用 PR 的历史目标提交代替当前版本。');
      }
      context.targetHeadOid = target.object.sha;
    }
    return opts.command === 'list' ? { ...context, truncated: entries.length > opts.limit, pullRequests: entries.slice(0, opts.limit) } : { ...context, pullRequest: data };
  } catch (error) {
    return error.auditError ?? { ok: false, code: 'UNEXPECTED_ERROR', message: '只读审计未完成。', impact, requiredAction: '检查当前项目和工具配置后重试。' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = audit(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
