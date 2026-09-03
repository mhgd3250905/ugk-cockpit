const text = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function validateDeliveryRequest(body, operation, { bridge = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Arguments must be an object';
  const allowed = operation === 'preflight'
    ? ['clientRequestId', 'sessionId', 'expectedRevision', 'files', 'selectFolder']
    : ['clientRequestId', 'preflightId', 'summary', 'allowConflicts', 'pullRequestUrl'];
  if (bridge) allowed.push('mcpWorkingDirectory');
  if (Object.keys(body).some((key) => !allowed.includes(key))) return 'Unexpected property in delivery request';
  if (!text(body.clientRequestId)) return 'clientRequestId is required';
  if (bridge && !text(body.mcpWorkingDirectory, 32768)) return 'MCP working directory is required';
  if (operation === 'preflight') {
    if (body.selectFolder !== undefined && typeof body.selectFolder !== 'boolean') return 'selectFolder must be boolean';
    if ((body.sessionId !== undefined || body.expectedRevision !== undefined)
      && (!text(body.sessionId) || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1)) return 'sessionId and expectedRevision must be supplied together';
    if (body.files !== undefined && (!Array.isArray(body.files) || body.files.length > 200
      || body.files.some((file) => !text(file, 1024) || file.includes('\0'))
      || new Set(body.files).size !== body.files.length)) return 'files must be a unique bounded list';
  } else {
    if (!text(body.preflightId)) return 'preflightId is required; run ugk_work_submit_preflight first';
    if (!text(body.summary, 160)) return 'summary must contain 1–160 characters';
    if (body.allowConflicts !== undefined && typeof body.allowConflicts !== 'boolean') return 'allowConflicts must be boolean';
    if (body.pullRequestUrl !== undefined) {
      try {
        const url = new URL(body.pullRequestUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash
          || !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)) return 'Invalid pullRequestUrl';
      } catch { return 'Invalid pullRequestUrl'; }
    }
  }
  return null;
}
