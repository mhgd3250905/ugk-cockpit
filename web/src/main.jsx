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

  useEffect(() => { refresh(); }, []);

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

  const projects = dashboard?.projects ?? [];
  const priority = useMemo(
    () => projects.find((item) => item.status === 'attention' || item.statusReason === 'run_may_be_interrupted')
      ?? projects.find((item) => item.status === 'active')
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
          {priority && <PriorityCard project={priority} />}
          <section className="project-section">
            <div className="section-heading">
              <div><p className="kicker">全部项目</p><h2>接下来可以做什么</h2></div>
              <button className="text-button" onClick={() => refresh()}>重新加载简报</button>
            </div>
            <div className="project-grid">
              {projects.map((project) => <ProjectCard key={project.id} project={project} />)}
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

function PriorityCard({ project }) {
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
      <p className="coming-soon">项目已添加 · 工作接手功能即将开放</p>
    </section>
  );
}

function ProjectCard({ project }) {
  const copy = STATUS[project.statusReason] ?? STATUS.ready_to_start;
  return (
    <article className={`project-card status-${project.status}`}>
      <div className="card-topline"><span>{STAGES[project.stage]}</span><time>{formatTime(project.lastObservedAt)}</time></div>
      <h3>{project.name}</h3>
      <p className="status-title">{copy.title}</p>
      <p>{copy.detail}</p>
      <div className="card-actions">
        <span className="coming-soon">项目已添加 · 工作接手功能即将开放</span>
        <details><summary>技术详情</summary><code>{project.path}</code></details>
      </div>
    </article>
  );
}

createRoot(document.getElementById('root')).render(<App />);
