const PLATFORM_LOGOS = {
  codex: '/assets/agent-openai.png',
  zcode: '/assets/agent-zcode.png',
};

export function agentPlatformPresentation(agent) {
  const label = typeof agent === 'string' && agent.trim() ? agent.trim() : '平台未记录';
  return { label, logo: PLATFORM_LOGOS[label.toLowerCase()] ?? null };
}
