import React, { useState } from 'react';
import { copyNoteText } from './copy-note-text.mjs';
import './skill-guide.css';

const skills = [
  { name: 'cockpit', title: '不知道从哪里开始', scene: '安装、打开工作台，或了解怎么用', description: '让 AI 按你的目标介绍用法、检查连接，并带你找到合适的下一步。单纯询问用法不会开始项目工作。', prompt: '$cockpit 请介绍各个技能的使用场景，并告诉我第一次使用该怎么开始。', detail: '也可以说：“帮我打开 UGK Cockpit 工作台。”' },
  { name: 'cockpit-init', title: '把项目交给当前 AI', scene: '新项目、已有开发，或工作台派发的任务', description: '先在工作台选择并授权项目，复制“交给 AI”的完整指令，粘贴到这个项目的聊天里。AI 确认接入后再开始工作。', prompt: '$cockpit-init 我想把当前项目接入 Cockpit，请引导我在工作台取得“交给 AI”的完整指令。', detail: '这句用于引导；真正开始需要工作台生成的完整指令。已有本地改动会保留。' },
  { name: 'cockpit-progress', title: '留下一条进展', scene: '已有工作会话，想记录成果或下一步', description: '把当前事实记到工作台。已接入的 AI 也会在成功产生代码提交等有效检查点后同步进展。', prompt: '$cockpit-progress 请把目前已完成的工作、验证结果和下一步记录到工作台。', detail: '只记录进展；不会因此提交或上传代码，也不会结束本阶段。' },
  { name: 'cockpit-relay', title: '换个聊天继续做', scene: '换聊天、换 AI，继续同一阶段', description: '在旧聊天准备接力，再把返回的完整接力指令贴到新聊天。新聊天确认恢复成功后，沿着已有进展继续。', prompt: '$cockpit-relay 我要换一个聊天继续当前工作，请准备接力指令，并带上待办和关键决定。', detail: '准备成功后旧聊天暂停修改，阶段仍保留；新聊天要使用完整接力指令，不能只粘贴这句示例。' },
  { name: 'cockpit-submit', title: '向主项目发工作说明', scene: '把发现、建议或进展交给项目负责人', description: '整理并发布一条工作说明，进入主项目的工作说明收件箱，等待处理。可以在尚未完成开发时使用。', prompt: '$cockpit-submit 请把当前工作的进展、发现和建议下一步整理成工作说明，发布到主项目。', detail: '发布说明与保存、上传代码是独立动作；说明发布成功不代表代码已经上传。' },
  { name: 'cockpit-closeout', title: '核对并保存本阶段成果', scene: '想对齐文档、验证结果并形成本地提交', description: '核对本阶段的目标、改动归属、文档和验证证据，修正确定的问题，再形成或复用有效的本地提交。', prompt: '$cockpit-closeout 请核对并收束当前阶段，完成必要验证并保存本地成果。', detail: '请明确使用这个技能名。可能修改文档和创建本地提交；完成后工作会话仍可继续，不自动上传。' },
  { name: 'cockpit-handoff', title: '明确结束本阶段', scene: '阶段完成，或需要以受阻、放弃结束', description: '整理成果、未完成事项和下一次重点，记录阶段结束。选择“完成”时会先核对并收束本地成果；受阻或放弃时如实保留待办。', prompt: '$cockpit-handoff 请以“完成”结束当前阶段，先核对并收束成果，再记录交接。', detail: '这会结束本阶段。如果只是换聊天继续，请使用接力。也可以明确要求以“受阻”或“放弃”结束。' },
];

function Example({ skill }) {
  const [state, setState] = useState('');
  async function copy() {
    setState('copying');
    try { setState(await copyNoteText(skill.prompt) ? 'copied' : 'failed'); }
    catch { setState('failed'); }
  }
  return <div className="sg-example">
    <div className="sg-example-bar"><span>在项目聊天中这样说</span><button type="button" onClick={copy} disabled={state === 'copying'} aria-label={`复制${skill.title}的示例`}>{state === 'copying' ? '正在复制…' : state === 'copied' ? '已复制' : '复制说法'}</button></div>
    <p className="sg-prompt" tabIndex={0} aria-label={`${skill.title}的示例，可选中复制`}>{skill.prompt}</p>
    <span className="sg-copy-status" role="status">{state === 'failed' ? '复制失败，请选中上方文字手动复制。' : state === 'copied' ? '已复制，请粘贴到项目聊天中发送。' : ''}</span>
  </div>;
}

export function SkillGuide() {
  return <div className="sg-page">
    <header className="sg-heading"><span className="sg-eyebrow">使用指南 · 7 个技能</span><h1>把下一步，交代给 AI。</h1><p>在聊天里说明你想做什么，让技能把工作进展带回工作台。这里的示例可以复制后按需修改；发送给 AI 后才会执行。</p></header>
    <section className="sg-start" aria-labelledby="sg-start-title"><div><span className="sg-section-label">第一次使用</span><h2 id="sg-start-title">从一个项目开始</h2></div><ol><li><strong>选择项目</strong><span>在工作台选择并授权要交给 AI 的项目。</span></li><li><strong>复制完整指令</strong><span>点击“交给 AI”，把指令贴到该项目的聊天。</span></li><li><strong>确认接入，再开工</strong><span>AI 确认成功后安排任务，随时回工作台查看进展。</span></li></ol></section>
    <section aria-labelledby="sg-skills-title"><div className="sg-section-heading"><h2 id="sg-skills-title">按你现在要做的事选择</h2><span>不用记住全部技能名</span></div><div className="sg-skills">{skills.map((skill, index) => <article className="sg-skill" key={skill.name}><div className="sg-skill-heading"><span className="sg-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div><span className="sg-skill-name">{skill.name}</span><h3>{skill.title}</h3></div></div><p className="sg-scene">{skill.scene}</p><p className="sg-description">{skill.description}</p><Example skill={skill}/><p className="sg-detail">{skill.detail}</p></article>)}</div></section>
    <section className="sg-difference" aria-labelledby="sg-difference-title"><div className="sg-section-heading"><h2 id="sg-difference-title">接力、收束、结束，怎么选？</h2></div><dl><div><dt>还要做，只是换聊天</dt><dd><strong>接力 · relay</strong><span>带着上下文去新聊天，继续当前阶段。</span></dd></div><div><dt>先核对并保存成果</dt><dd><strong>收束 · closeout</strong><span>对齐文档与验证，保存本地成果，会话继续。</span></dd></div><div><dt>这一阶段明确结束</dt><dd><strong>交接 · handoff</strong><span>留下下一次所需的记录，结束当前阶段。</span></dd></div></dl></section>
    <footer className="sg-footer">拿不准时，直接问 AI：“我现在这个情况应该用哪个 Cockpit 技能？”只问用法会得到说明，不会替你执行操作。</footer>
  </div>;
}
