// Windows CreateProcess resolves bare executable names (e.g. `git`,
// `powershell.exe`) against the *parent* process working directory before
// PATH. Every git probe in this codebase runs with the repository under
// audit as its child cwd, so a planted git.exe in that directory would be
// executed before any argv or repository-policy hardening applies.
//
// Setting this environment variable removes the current-directory entry
// from the search order for every process this process spawns. CreateProcess
// reads the flag from the caller's environment on each spawn, so setting it
// once at module load covers all later execFile/spawn calls, including the
// unqualified 'git' and 'powershell.exe' names used by the git and platform
// layers. PATH resolution is unaffected; non-Windows platforms are no-ops.
//
// Verified on Windows 24H2: without the flag, execFile('git') executes a
// git.exe planted in the parent cwd; with it, resolution goes to PATH.
if (process.platform === 'win32') {
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
}
