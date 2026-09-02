import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api.js';
import './styles.css';

const STATUS = {
  preexisting_changes: {
    eyebrow: '需要你确认',
    title: '开始前已经有本地改动',
    detail: '这些改动会原样保留，不会自动算给下一位 AI。',
    action: '查看并继续',
  },
  run_may_be_interrupted: {
    eyebrow: '今天先处理',
    title: '上一次 AI 可能没有正常结束',
    detail: '代码没有被删除。先恢复记录，再决定从哪里继续。',
    action: '恢复这次工作',
  },
  status_check_incomplete: {
    eyebrow: '暂时无法确认',
    title: '刚才没有读完代码状态',
    detail: '页面不会把旧信息当成最新结果。',
    action: '重新检查',
  },
  ready_to_start: {
    eyebrow: '可以继续',
    title: '这份代码已经准备好',
    detail: '开始时会先记录当前状态，已有文件不会被清理。',
    action: '开始工作',
  },
  assignment_waiting: {
    eyebrow: '等待接手',
    title: '任务已经准备好，等待 AI 接手',
    detail: '只有 AI 成功接手后，这里才会显示正在工作。',
    action: '查看接手消息',
  },
  active_work: {
    eyebrow: '正在推进',
    title: 'AI 已经接手这项任务',
    detail: '最近进展和结束交接会自动回到这里。',
    action: '查看进展',
  },
  relay_waiting: {
    eyebrow: '接力已准备',
    title: '等待新会话继续',
    detail: '接力记录已经保存；原工作会话和写入权限仍保持 active，不会重新发起 init。',
    action: '等待新会话继续',
  },
  agent_waiting: {
    eyebrow: '已经接上上下文',
    title: 'AI 已读取上次交接，等待你的安排',
    detail: '现在还没有占用写入会话；你给出任务后，AI 才会开始修改代码。',
    action: '继续对话',
  },
};

const STAGES = {
  development: '开发中',
  maintenance: '已上线 · 日常维护',
  paused: '暂时放下',
};

const api = createApiClient({
  fetchImpl: (...args) => fetch(...args),
  storage: localStorage,
  randomUUID: () => crypto.randomUUID(),
  origin: window.location.origin,
});

function formatTime(value) {
  if (!value) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function App() {
  const [dashboard, setDashboard] = useState(null);
  const [selection, setSelection] = useState(null);
  const [name, setName] = useState('');
  const [stage, setStage] = useState('development');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [handoffProject, setHandoffProject] = useState(null);
  const [handoffAgent, setHandoffAgent] = useState('Codex');
  const [handoffGoal, setHandoffGoal] = useState('');
  const [dispatch, setDispatch] = useState(null);

  async function refresh({ successNotice = null } = {}) {
    try {
      setDashboard(await api('/api/v1/dashboard'));
      setNotice(successNotice);
    } catch (error) {
      setNotice({
        title: error.message || '控制台暂时离线',
        detail: error.impact || '代码不受影响；没有确认保存的操作不会显示为成功。',
        actionLabel: '重新加载简报',
        retry: () => refresh(),
      });
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(async () => {
      try { setDashboard(await api('/api/v1/dashboard')); } catch { /* Keep the last good brief. */ }
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  async function chooseFolder() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api('/api/v1/folders/select', { method: 'POST', body: '{}' });
      if (!result.cancelled) {
        setSelection({ ...result, commandId: crypto.randomUUID() });
        setName(result.folderName);
      }
    } catch (error) {
      setNotice({
        title: error.message || '没有完成文件夹选择。',
        detail: error.required_action || error.impact || '请重新打开选择窗口后再试。',
        actionLabel: '重新选择项目文件夹',
        retry: () => chooseFolder(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    if (!selection) {
      await chooseFolder();
      return;
    }
    setBusy(true);
    try {
      const project = await api('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({
          commandId: selection.commandId,
          grantId: selection.grantId,
          name,
          stage,
        }),
      });
      setSelection(null);
      await refresh({
        successNotice: {
          title: project.alreadyExists
            ? `${project.name} 已经在工作简报中。`
            : `已添加 ${project.name}。`,
          detail: project.alreadyExists
            ? '没有创建重复项目，原有记录保持不变。'
            : '它现在已经出现在你的工作简报中；项目代码没有被修改。',
          actionLabel: '知道了',
          retry: () => setNotice(null),
        },
      });
    } catch (error) {
      const needsReselection = ['FOLDER_GRANT_EXPIRED', 'FOLDER_SELECTION_CHANGED'].includes(error.code);
      if (needsReselection) setSelection(null);
      setNotice({
        title: error.message || '项目还没有确认添加。',
        detail: error.required_action || error.impact || '当前确认内容已保留，请重试。',
        actionLabel: needsReselection ? '重新选择项目文件夹' : '重试确认添加',
        retry: needsReselection ? () => chooseFolder() : () => register(),
      });
    } finally {
      setBusy(false);
    }
  }

  function openHandoff(project) {
    setHandoffProject(project);
    setHandoffAgent(project.pendingAssignment?.mode === 'adopt' && project.pendingAssignment?.agent
      ? project.pendingAssignment.agent
      : 'Codex');
    setHandoffGoal(project.pendingAssignment?.mode === 'adopt'
      ? (project.pendingAssignment.task ?? '')
      : '');
    setDispatch(null);
    setNotice(null);
  }

  async function reissueInit(project, agent = handoffAgent) {
    setBusy(true);
    try {
      const result = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/assignments/reissue`, {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          mode: 'init',
          agent,
        }),
      });
      setDispatch(result);
    } catch (error) {
      setNotice({
        title: error.message || '还没有重新生成接入指令。',
        detail: error.required_action || error.impact || '请刷新状态后重试。',
        actionLabel: '重试生成',
        retry: () => reissueInit(project, agent),
      });
    } finally {
      setBusy(false);
    }
  }

  async function createHandoff() {
    if (handoffProject.pendingAssignment?.mode === 'adopt') {
      await reissueInit(handoffProject, handoffAgent);
      return;
    }
    setBusy(true);
    try {
      const result = await api(`/api/v1/projects/${encodeURIComponent(handoffProject.id)}/assignments`, {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          agent: handoffAgent,
          mode: 'init',
          task: handoffGoal.trim(),
        }),
      });
      setDispatch(result);
      await refresh();
    } catch (error) {
      setNotice({
        title: error.message || '还没有创建接手任务。',
        detail: error.required_action || error.impact || '请检查任务目标后重试。',
        actionLabel: '重试创建',
        retry: () => createHandoff(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function copyDispatchMessage() {
    await navigator.clipboard.writeText(dispatch.message);
    setNotice({
      title: '接手消息已复制。',
      detail: `把它发送给 ${handoffAgent}；成功接入后页面会显示正在工作。`,
      actionLabel: '知道了',
      retry: () => setNotice(null),
    });
  }

  const projects = dashboard?.projects ?? [];
  const priority = useMemo(
    () => projects.find((item) => item.status === 'attention' || item.statusReason === 'run_may_be_interrupted')
      ?? projects.find((item) => item.status === 'active')
      ?? projects.find((item) => item.statusReason === 'agent_waiting')
      ?? projects[0],
    [projects],
  );

  return (
    <main className="page-shell">
      <header className="masthead">
        <div>
          <p className="edition">UGK COCKPIT · 本地工作简报</p>
          <h1>今天，从一件明确的事开始。</h1>
        </div>
        <button className="quiet-button" onClick={() => chooseFolder()} disabled={busy}>
          <span aria-hidden="true">＋</span> 选择项目文件夹
        </button>
      </header>

      <div className="rule"><span>{formatTime(dashboard?.refreshedAt)}</span></div>

      {notice && !selection && <Notice notice={notice} busy={busy} />}

      {!dashboard ? (
        notice
          ? <section className="loading-state">今日简报尚未加载；代码不受影响。</section>
          : <section className="loading-state"><span className="spinner" />正在整理你的今日简报…</section>
      ) : projects.length === 0 ? (
        <section className="empty-state">
          <p className="kicker">第一步 · 约一分钟</p>
          <h2>先把一个项目放到这里</h2>
          <p>从电脑中手动选择一个项目文件夹。我们只读取必要的代码状态，不会清理、覆盖、提交、上传或删除文件。</p>
          <div className="folder-actions">
            <button className="primary-button" onClick={() => chooseFolder()} disabled={busy}>
              {busy ? '正在等待你选择…' : '选择项目文件夹'}
            </button>
          </div>
          <small>一次只添加你亲自选择的一个项目；取消不会保存任何内容。</small>
        </section>
      ) : (
        <>
          {priority && <PriorityCard project={priority} onAssign={openHandoff} />}
          <section className="project-section">
            <div className="section-heading">
              <div><p className="kicker">全部项目</p><h2>接下来可以做什么</h2></div>
              <button className="text-button" onClick={() => refresh()}>重新加载简报</button>
            </div>
            <div className="project-grid">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} onAssign={openHandoff} />
              ))}
            </div>
          </section>
        </>
      )}

      {selection && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <p className="kicker">确认添加范围</p>
            <h2 id="confirm-title">我们只会添加这一份代码</h2>
            <div className="scope-counts"><span>已选择文件夹</span><strong>{selection.folderName}</strong></div>
            <p className="safety-copy">{selection.promise}</p>
            <label>项目名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>目前阶段
              <select value={stage} onChange={(event) => setStage(event.target.value)}>
                <option value="development">开发中</option>
                <option value="maintenance">已经上线，只做维护</option>
                <option value="paused">暂时放下</option>
              </select>
            </label>
            <details><summary>查看技术位置</summary><code>{selection.folderPath}</code></details>
            {notice && <Notice notice={notice} busy={busy} />}
            <div className="sheet-actions">
              <button className="text-button" onClick={() => { setSelection(null); setNotice(null); }} disabled={busy}>取消</button>
              <button className="primary-button" onClick={register} disabled={busy || !name.trim()}>
                {busy ? '正在安全检查…' : '确认添加'}
              </button>
            </div>
          </section>
        </div>
      )}

      {handoffProject && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
            <p className="kicker">交给 AI</p>
            <h2 id="handoff-title">{handoffProject.name}</h2>
            {!dispatch ? (
              <>
                <label>交给谁
                  <select value={handoffAgent} onChange={(event) => setHandoffAgent(event.target.value)}>
                    <option>Codex</option>
                    <option>ZCode</option>
                    <option>Antigravity</option>
                  </select>
                </label>
                <label>可选目标
                  <textarea
                    value={handoffGoal}
                    onChange={(event) => setHandoffGoal(event.target.value)}
                    rows="4"
                    maxLength="1000"
                    placeholder="可以留空；例如：完成登录页的接口联调"
                  />
                </label>
              </>
            ) : (
              <>
                <p className="safety-copy">
                  接入指令已创建。
                  复制下面的消息给 {handoffAgent}，MCP 成功后首页会自动更新。
                </p>
                <label>接入消息
                  <textarea className="dispatch-message" value={dispatch.message} readOnly rows="9" />
                </label>
                <small>接手码将在 {formatTime(dispatch.expiresAt)} 前有效；消息里不包含项目路径或本地 API token。</small>
              </>
            )}
            {notice && <Notice notice={notice} busy={busy} />}
            <div className="sheet-actions">
              <button className="text-button" onClick={() => { setHandoffProject(null); setNotice(null); }} disabled={busy}>关闭</button>
              {!dispatch ? (
                <button
                  className="primary-button"
                  onClick={createHandoff}
                  disabled={busy}
                >
                  {busy ? '正在创建…' : '生成接入指令'}
                </button>
              ) : (
                <button className="primary-button" onClick={copyDispatchMessage}>复制接手消息</button>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Notice({ notice, busy }) {
  return (
    <section className="notice" role="alert">
      <strong>{notice.title}</strong>
      <span>{notice.detail}</span>
      <button onClick={notice.retry} disabled={busy}>{notice.actionLabel}</button>
    </section>
  );
}

function PriorityCard({ project, onAssign }) {
  const copy = STATUS[project.statusReason] ?? STATUS.ready_to_start;
  return (
    <section className="priority-card">
      <div className="priority-index">01</div>
      <div>
        <p className="kicker">{copy.eyebrow}</p>
        <h2>{project.name}</h2>
        <h3>{copy.title}</h3>
        <p>{copy.detail}</p>
      </div>
      <button
        className="primary-button"
        onClick={() => onAssign(project)}
        disabled={['active_work', 'relay_waiting', 'agent_waiting'].includes(project.statusReason)}
      >
        {project.statusReason === 'active_work'
          ? 'AI 正在工作'
          : (project.statusReason === 'relay_waiting'
            ? '等待新会话继续'
            : (project.statusReason === 'agent_waiting' ? '等待你的安排' : '交给 AI'))}
      </button>
    </section>
  );
}

function ProjectCard({ project, onAssign }) {
  const copy = STATUS[project.statusReason] ?? STATUS.ready_to_start;
  return (
    <article className={`project-card status-${project.status}`}>
      <div className="card-topline"><span>{STAGES[project.stage]}</span><time>{formatTime(project.lastObservedAt)}</time></div>
      <h3>{project.name}</h3>
      <p className="status-title">{copy.title}</p>
      <p>{copy.detail}</p>
      {project.lastHandoffManual && (
        <details className="handoff-summary">
          <summary>上次交接</summary>
          <p>{project.lastHandoffManual.summary || '已保存标准交接手册'}</p>
          {project.lastHandoffManual.nextSessionFocus && (
            <small>建议下一步：{project.lastHandoffManual.nextSessionFocus}</small>
          )}
        </details>
      )}
      <div className="card-actions">
        <button
          onClick={() => onAssign(project)}
          disabled={['active_work', 'relay_waiting', 'agent_waiting'].includes(project.statusReason)}
        >
          {project.statusReason === 'active_work'
            ? 'AI 正在工作'
            : (project.statusReason === 'relay_waiting'
              ? '等待新会话继续'
              : (project.statusReason === 'agent_waiting' ? '等待你的安排' : '交给 AI'))}
        </button>
        <details><summary>技术详情</summary><code>{project.path}</code></details>
      </div>
    </article>
  );
}

createRoot(document.getElementById('root')).render(<App />);
