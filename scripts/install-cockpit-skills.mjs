import { cpSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COCKPIT_SKILL_NAMES = [
  'cockpit-init',
  'cockpit-progress',
  'cockpit-relay',
  'cockpit-submit',
  'cockpit-closeout',
  'cockpit-handoff',
];

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultCodexSkillsRoot({ env = process.env, home = os.homedir() } = {}) {
  const codexRoot = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return path.join(codexRoot, 'skills');
}

function parseArgs(args) {
  let targetRoot = null;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--force') {
      force = true;
      continue;
    }
    if (argument === '--target' && args[index + 1]) {
      targetRoot = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return { targetRoot, force };
}

export function installCockpitSkills({
  sourceRoot = path.join(repositoryRoot, 'skills'),
  targetRoot = defaultCodexSkillsRoot(),
  force = false,
} = {}) {
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedTarget = path.resolve(targetRoot);
  const missing = COCKPIT_SKILL_NAMES.filter(
    (name) => !existsSync(path.join(resolvedSource, name, 'SKILL.md')),
  );
  if (missing.length > 0) {
    throw new Error(`Missing Cockpit skill packages: ${missing.join(', ')}`);
  }

  mkdirSync(resolvedTarget, { recursive: true });
  const existing = COCKPIT_SKILL_NAMES.filter((name) => existsSync(path.join(resolvedTarget, name)));
  if (existing.length > 0 && !force) {
    throw new Error(
      `Refusing to overwrite existing skills: ${existing.join(', ')}. Re-run with --force after reviewing them.`,
    );
  }

  for (const name of COCKPIT_SKILL_NAMES) {
    cpSync(path.join(resolvedSource, name), path.join(resolvedTarget, name), {
      recursive: true,
      force,
      errorOnExist: !force,
    });
  }
  return { targetRoot: resolvedTarget, installed: [...COCKPIT_SKILL_NAMES] };
}

function main() {
  const { targetRoot, force } = parseArgs(process.argv.slice(2));
  const result = installCockpitSkills({
    targetRoot: targetRoot ?? defaultCodexSkillsRoot(),
    force,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
