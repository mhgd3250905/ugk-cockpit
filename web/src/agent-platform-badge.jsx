import React, { useState } from 'react';
import { agentPlatformPresentation } from './agent-platform.mjs';

export function AgentPlatformBadge({ agent, id }) {
  const { label, logo } = agentPlatformPresentation(agent);
  const [failedLogo, setFailedLogo] = useState(null);
  return (
    <span id={id} className="agent-platform-badge" title={`Agent 平台：${label}`}>
      <span className="sr-only">Agent 平台：</span>
      {logo && failedLogo !== logo && <img src={logo} width="16" height="16" alt="" onError={() => setFailedLogo(logo)} />}
      <span>{label}</span>
    </span>
  );
}
