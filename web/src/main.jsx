import React, { useEffect, useMemo, useRef, useState } from 'react';
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
    action: '交给 AI',
  },
  assignment_waiting: {
    eyebrow: '等待接手',
    title: '任务已经准备好，等待 AI 接手',
    detail: '只有 AI 成功接手后，这里才会显示工作会话已经接入。',
    action: '重新生成接入指令',
  },
  active_work: {
    eyebrow: '会话已接入',
    title: '这项工作尚未交接',
    detail: 'Cockpit 已记录 AI 接入和最近进展；只有明确交接后，这段工作才会结束。',
    action: '会话尚未交接',
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
    action: '等待你的安排',
  },
  user_paused: {
    eyebrow: '暂时放下',
    title: '这份项目已由你主动暂停',
    detail: 'Cockpit 不会在暂停期间创建新的 AI 接手任务。',
    action: '已暂时放下',
  },
};

const STAGES = {
  development: '开发中',
  maintenance: '日常维护',
  paused: '暂时放下',
};

const TIMELINE_KINDS = {
  init: { code: 'INIT', label: '接入项目' },
  progress: { code: 'PROGRESS', label: '工作进展' },
  relay: { code: 'RELAY', label: '聊天接力' },
  handoff: { code: 'HANDOFF', label: '阶段交接' },
};

const api = createApiClient({
  fetchImpl: (...args) => fetch(...args),
  storage: localStorage,
  randomUUID: () => crypto.randomUUID(),
  origin: window.location.origin,
});

function formatTime(value) {
  if (!value) return '尚无记录';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function getProjectStatusReason(project) {
  if (project?.status === 'paused' || project?.stage === 'paused') return 'user_paused';
  return project?.statusReason ?? 'ready_to_start';
}

function getProjectTheme(project) {
  if (project?.stage === 'paused' || project?.stage === 'maintenance') {
    return 'paused';
  }
  const reason = getProjectStatusReason(project);
  if (
    project?.status === 'attention' ||
    ['status_check_incomplete', 'preexisting_changes'].includes(reason)
  ) {
    return 'attention';
  }
  if (
    project?.status === 'active' ||
    ['active_work', 'relay_waiting', 'agent_waiting', 'assignment_waiting'].includes(reason)
  ) {
    return 'active';
  }
  return 'ready';
}

function getActionLabel(statusReason) {
  switch (statusReason) {
    case 'active_work':
      return '会话尚未交接';
    case 'relay_waiting':
      return '等待新会话继续';
    case 'agent_waiting':
      return '等待你的安排';
    case 'assignment_waiting':
      return '重新生成接入指令';
    case 'user_paused':
      return '已暂时放下';
    case 'preexisting_changes':
      return '查看并继续';
    case 'status_check_incomplete':
      return '重新检查';
    case 'ready_to_start':
    default:
      return '交给 AI';
  }
}

function isActionDisabled(statusReason) {
  return ['active_work', 'relay_waiting', 'agent_waiting', 'user_paused'].includes(statusReason);
}

function createErrorNotice(error, {
  message,
  impact,
  requiredAction,
  actionLabel,
  retry,
}) {
  return {
    message: error?.message ?? message,
    impact: error?.impact ?? impact,
    required_action: error?.required_action ?? requiredAction,
    actionLabel,
    retry,
  };
}

function useFocusTrap(isOpen, onClose, busy = false) {
  const modalRef = useRef(null);
  const triggerRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!isOpen) return;
    triggerRef.current = document.activeElement;

    const timer = setTimeout(() => {
      if (!modalRef.current) return;
      const focusables = modalRef.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        modalRef.current.focus();
      }
    }, 20);

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        if (busyRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        if (!modalRef.current) return;
        const focusables = Array.from(
          modalRef.current.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null);

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown, true);
      if (triggerRef.current && typeof triggerRef.current.focus === 'function') {
        triggerRef.current.focus();
      }
    };
  }, [isOpen]);

  return modalRef;
}

function App() {
  const [dashboard, setDashboard] = useState(null);
  const [isStale, setIsStale] = useState(false);
  const [selection, setSelection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [handoffProject, setHandoffProject] = useState(null);
  const [handoffAgent, setHandoffAgent] = useState('Codex');
  const [handoffGoal, setHandoffGoal] = useState('');
  const [dispatch, setDispatch] = useState(null);
  const [projectDetail, setProjectDetail] = useState(null);
  const detailRequestRef = useRef(0);

  async function refresh({ successNotice = null } = {}) {
    try {
      const data = await api('/api/v1/dashboard');
      setDashboard(data);
      setIsStale(false);
      setNotice(successNotice);
    } catch (error) {
      setIsStale(true);
      setNotice(createErrorNotice(error, {
        message: '控制台暂时离线。',
        impact: '代码不受影响；没有确认保存的操作不会显示为成功。',
        requiredAction: '请确认本地控制台仍在运行，然后重新加载简报。',
        actionLabel: '重新加载简报',
        retry: () => refresh(),
      }));
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(async () => {
      try {
        const data = await api('/api/v1/dashboard');
        setDashboard(data);
        setIsStale(false);
      } catch {
        setIsStale(true);
      }
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
      }
    } catch (error) {
      setNotice(createErrorNotice(error, {
        message: '没有完成文件夹选择。',
        impact: '没有保存新的项目记录，项目代码不受影响。',
        requiredAction: '请重新打开选择窗口后再试。',
        actionLabel: '重新选择项目文件夹',
        retry: () => chooseFolder(),
      }));
    } finally {
      setBusy(false);
    }
  }

  async function register(projectName, projectStage) {
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
          name: projectName,
          stage: projectStage,
        }),
      });
      setSelection(null);
      await refresh({
        successNotice: {
          message: project.alreadyExists
            ? `${project.name} 已经在工作简报中。`
            : `已添加 ${project.name}。`,
          impact: project.alreadyExists
            ? '没有创建重复项目，原有记录保持不变。'
            : '它现在已经出现在你的工作简报中；项目代码没有被修改。',
          actionLabel: '知道了',
          retry: () => setNotice(null),
        },
      });
    } catch (error) {
      const needsReselection = ['FOLDER_GRANT_EXPIRED', 'FOLDER_SELECTION_CHANGED'].includes(error.code);
      if (needsReselection) setSelection(null);
      setNotice(createErrorNotice(error, {
        message: '项目还没有确认添加。',
        impact: '没有新增或覆盖项目记录，项目代码不受影响。',
        requiredAction: needsReselection
          ? '文件夹授权已失效或代码位置身份发生变化，请重新选择项目文件夹。'
          : '当前确认内容已保留，请重试确认添加。',
        actionLabel: needsReselection ? '重新选择项目文件夹' : '重试确认添加',
        retry: needsReselection ? () => chooseFolder() : () => register(projectName, projectStage),
      }));
    } finally {
      setBusy(false);
    }
  }

  function openHandoff(project) {
    setHandoffProject(project);
    setHandoffAgent(
      project.pendingAssignment?.mode === 'adopt' && project.pendingAssignment?.agent
        ? project.pendingAssignment.agent
        : 'Codex'
    );
    setHandoffGoal(
      project.pendingAssignment?.mode === 'adopt'
        ? (project.pendingAssignment.task ?? '')
        : ''
    );
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
      setNotice(createErrorNotice(error, {
        message: '还没有重新生成接入指令。',
        impact: '原接手任务和项目代码保持不变。',
        requiredAction: '请刷新状态后重试。',
        actionLabel: '重试生成',
        retry: () => reissueInit(project, agent),
      }));
    } finally {
      setBusy(false);
    }
  }

  async function createHandoff() {
    if (!handoffProject) return;
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
      setNotice(createErrorNotice(error, {
        message: '还没有创建接手任务。',
        impact: '没有确认创建新的接手任务，项目代码不受影响。',
        requiredAction: '请检查任务目标和当前项目状态后重试。',
        actionLabel: '重试创建',
        retry: () => createHandoff(),
      }));
    } finally {
      setBusy(false);
    }
  }

  async function copyDispatchMessage() {
    if (!dispatch?.message) return;
    try {
      await navigator.clipboard.writeText(dispatch.message);
      setNotice({
        message: '接手消息已复制。',
        required_action: `把它发送给 ${handoffAgent}；成功接入后页面会显示工作会话已经接入。`,
        actionLabel: '知道了',
        retry: () => setNotice(null),
      });
    } catch {
      setNotice({
        message: '无法自动写入剪贴板。',
        impact: '接入指令仍完整显示，项目代码和接手任务不受影响。',
        required_action: '请直接选中文本框内的完整接入指令并按 Ctrl+C / Cmd+C 复制。',
        actionLabel: '重试复制',
        retry: () => copyDispatchMessage(),
      });
    }
  }

  function handleProjectAction(project) {
    const statusReason = getProjectStatusReason(project);
    if (isActionDisabled(statusReason)) return;
    if (statusReason === 'status_check_incomplete') {
      refresh();
      return;
    }
    openHandoff(project);
  }

  async function openProjectDetail(project) {
    const requestId = ++detailRequestRef.current;
    setProjectDetail({ seed: project, data: null, loading: true, loadingMore: false, error: null });
    try {
      const data = await api(`/api/v1/projects/${encodeURIComponent(project.id)}?limit=30&offset=0`);
      if (detailRequestRef.current !== requestId) return;
      setProjectDetail({ seed: project, data, loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (detailRequestRef.current !== requestId) return;
      setProjectDetail({
        seed: project,
        data: null,
        loading: false,
        loadingMore: false,
        error: createErrorNotice(error, {
          message: '暂时没有读到项目运行详情。',
          impact: '项目代码和已有工作记录不受影响。',
          requiredAction: '请确认本机服务已更新，然后重试读取。',
        }),
      });
    }
  }

  function closeProjectDetail() {
    detailRequestRef.current += 1;
    setProjectDetail(null);
  }

  async function loadOlderTimeline() {
    const detail = projectDetail;
    const timeline = detail?.data?.timeline;
    if (!detail || !timeline?.hasMore || detail.loadingMore) return;
    setProjectDetail((current) => current ? { ...current, loadingMore: true } : current);
    try {
      const page = await api(
        `/api/v1/projects/${encodeURIComponent(detail.seed.id)}/timeline?limit=30&offset=${timeline.items.length}`
      );
      setProjectDetail((current) => {
        if (!current || current.seed.id !== detail.seed.id || !current.data) return current;
        return {
          ...current,
          loadingMore: false,
          data: {
            ...current.data,
            timeline: {
              ...current.data.timeline,
              total: page.total,
              hasMore: page.hasMore,
              items: [...current.data.timeline.items, ...page.items],
            },
          },
        };
      });
    } catch (error) {
      setProjectDetail((current) => current ? {
        ...current,
        loadingMore: false,
        error: createErrorNotice(error, {
          message: '更早的节点暂时没有加载出来。',
          impact: '已显示的记录和项目代码不受影响。',
          requiredAction: '稍后可以再次尝试加载。',
        }),
      } : current);
    }
  }

  const projects = dashboard?.projects ?? [];

  const stats = useMemo(() => {
    const total = projects.length;
    let attentionCount = 0;
    let activeCount = 0;
    let readyCount = 0;
    let pausedCount = 0;

    for (const project of projects) {
      const theme = getProjectTheme(project);
      if (theme === 'attention') attentionCount++;
      else if (theme === 'active') activeCount++;
      else if (theme === 'ready') readyCount++;
      else if (theme === 'paused') pausedCount++;
    }

    return { total, attentionCount, activeCount, readyCount, pausedCount };
  }, [projects]);

  const groups = useMemo(() => {
    const attentionList = [];
    const activeList = [];
    const readyList = [];
    const pausedList = [];

    for (const item of projects) {
      const theme = getProjectTheme(item);
      if (theme === 'attention') {
        attentionList.push(item);
      } else if (theme === 'active') {
        activeList.push(item);
      } else if (theme === 'ready') {
        readyList.push(item);
      } else if (theme === 'paused') {
        pausedList.push(item);
      }
    }

    return [
      { key: 'attention', title: '待确认 · 需要处理', list: attentionList },
      { key: 'active', title: '工作会话 · 接入或未交接', list: activeList },
      { key: 'ready', title: '准备就绪 · 可以继续', list: readyList },
      { key: 'paused', title: '日常维护与暂时放下', list: pausedList },
    ].filter((g) => g.list.length > 0);
  }, [projects]);

  return (
    <div className="mission-control-shell">
      <header className="control-header">
        <div className="header-main-row">
          <div className="brand-zone">
            <div className="brand-title-wrap">
              <span className="brand-mark" aria-hidden="true">■</span>
              <h1 className="brand-title">UGK Cockpit</h1>
              <span className="badge badge-version">v0.1.0-alpha.18</span>
            </div>
            <p className="brand-tagline">本机 AI 项目控制台 · Local-First Mission Control</p>
          </div>

          <div className="header-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => refresh()}
              disabled={busy}
              title="重新加载简报数据"
            >
              <span className="btn-icon" aria-hidden="true">↻</span> 重新加载简报
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => chooseFolder()}
              disabled={busy}
            >
              <span className="btn-icon" aria-hidden="true">＋</span> 选择项目文件夹
            </button>
          </div>
        </div>

        <div className="header-status-row">
          <div className="connection-status">
            <span className={`status-indicator-dot ${isStale ? 'dot-stale' : 'dot-active'}`} />
            <span className="status-label">
              {isStale
                ? (dashboard ? '连接暂缓（已保留最后已知简报）' : '连接暂缓（尚未取得简报）')
                : '本机服务运行中'}
            </span>
            <span className="status-sep">·</span>
            <time className="status-time">
              {dashboard?.refreshedAt ? `同步于 ${formatTime(dashboard.refreshedAt)}` : '正在同步…'}
            </time>
            {isStale && (
              <button type="button" className="btn-link" onClick={() => refresh()}>
                重试连接
              </button>
            )}
          </div>

          {projects.length > 0 && (
            <div className="header-stats" aria-label="项目状态统计">
              <span className="stat-badge">全部 <strong>{stats.total}</strong></span>
              {stats.attentionCount > 0 && (
                <span className="stat-badge stat-attention">待确认 <strong>{stats.attentionCount}</strong></span>
              )}
              {stats.activeCount > 0 && (
                <span className="stat-badge stat-active">会话中 <strong>{stats.activeCount}</strong></span>
              )}
              {stats.readyCount > 0 && (
                <span className="stat-badge stat-ready">就绪 <strong>{stats.readyCount}</strong></span>
              )}
              {stats.pausedCount > 0 && (
                <span className="stat-badge stat-muted">维护/放下 <strong>{stats.pausedCount}</strong></span>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="control-content">
        {notice && !selection && !handoffProject && !projectDetail && (
          <NoticeBanner notice={notice} busy={busy} />
        )}

        {!dashboard ? (
          <LoadingState notice={notice} />
        ) : projects.length === 0 ? (
          <EmptyState busy={busy} onChoose={() => chooseFolder()} />
        ) : (
          groups.length > 0 && (
            <section className="projects-section" aria-label="项目矩阵">
              <div className="section-toolbar">
                <h2 className="section-heading">全部项目</h2>
                <span className="section-subtitle">
                  共 {projects.length} 个项目 · 按状态分组
                </span>
              </div>

              <div className="groups-container">
                {groups.map((group) => (
                  <div key={group.key} className="status-group">
                    <div className="group-header">
                      <h3 className="group-title">{group.title}</h3>
                      <span className="group-count">{group.list.length}</span>
                    </div>
                    <div className="group-grid">
                      {group.list.map((project) => (
                        <ProjectCard
                          key={project.id}
                          project={project}
                          onAction={handleProjectAction}
                          onOpen={openProjectDetail}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        )}
      </main>

      {selection && (
        <ConfirmAddModal
          selection={selection}
          onClose={() => { setSelection(null); setNotice(null); }}
          onRegister={register}
          busy={busy}
          notice={notice}
        />
      )}

      {handoffProject && (
        <HandoffModal
          project={handoffProject}
          agent={handoffAgent}
          setAgent={setHandoffAgent}
          goal={handoffGoal}
          setGoal={setHandoffGoal}
          dispatch={dispatch}
          busy={busy}
          notice={notice}
          onClose={() => { setHandoffProject(null); setNotice(null); setDispatch(null); }}
          onCreate={createHandoff}
          onCopy={copyDispatchMessage}
        />
      )}

      {projectDetail && (
        <ProjectDetailModal
          state={projectDetail}
          onClose={closeProjectDetail}
          onRetry={() => openProjectDetail(projectDetail.seed)}
          onLoadOlder={loadOlderTimeline}
        />
      )}
    </div>
  );
}

function NoticeBanner({ notice, busy }) {
  if (!notice) return null;
  return (
    <section className="notice-banner" role="alert">
      <div className="notice-content">
        <strong className="notice-title">{notice.message}</strong>
        {notice.impact && (
          <p className="notice-detail"><strong>影响：</strong>{notice.impact}</p>
        )}
        {notice.required_action && (
          <p className="notice-detail"><strong>下一步：</strong>{notice.required_action}</p>
        )}
      </div>
      {notice.actionLabel && notice.retry && (
        <button
          type="button"
          className="btn btn-secondary btn-sm notice-btn"
          onClick={notice.retry}
          disabled={busy}
        >
          {notice.actionLabel}
        </button>
      )}
    </section>
  );
}

function LoadingState({ notice }) {
  if (notice) {
    return (
      <section className="feedback-state-box">
        <p className="feedback-text">今日简报尚未加载；代码不受影响。</p>
      </section>
    );
  }
  return (
    <section className="feedback-state-box">
      <span className="loading-spinner" aria-hidden="true" />
      <p className="feedback-text">正在整理你的今日简报…</p>
    </section>
  );
}

function EmptyState({ busy, onChoose }) {
  return (
    <section className="empty-state-box">
      <div className="empty-badge">第一步 · 约一分钟</div>
      <h2 className="empty-title">先把一个项目放到这里</h2>
      <p className="empty-desc">
        从电脑中手动选择一个项目文件夹。我们只读取必要的代码状态，绝不会自动清理、覆盖、提交、上传或删除你的任何文件。
      </p>
      <div className="empty-actions">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={onChoose}
          disabled={busy}
        >
          {busy ? '正在等待你选择…' : '选择项目文件夹'}
        </button>
      </div>
      <small className="empty-note">
        一次只添加你亲自选择的一个项目；取消不会保存任何内容。
      </small>
    </section>
  );
}

function ProjectCard({ project, onAction, onOpen }) {
  const statusReason = getProjectStatusReason(project);
  const copy = STATUS[statusReason] ?? STATUS.ready_to_start;
  const actionLabel = getActionLabel(statusReason);
  const isDisabled = isActionDisabled(statusReason);
  const theme = getProjectTheme(project);
  const agent = project.activeWork?.agent
    ?? project.waitingAgent?.agent
    ?? project.pendingAssignment?.agent
    ?? project.activeRun?.agentClaim
    ?? null;
  const confirmedAt = project.activeWork?.lastProgress?.createdAt
    ?? project.activeWork?.lastActivityAt
    ?? project.lastObservedAt;

  return (
    <article className={`project-item-card status-theme-${theme}`}>
      <button
        type="button"
        className="project-card-open"
        onClick={() => onOpen(project)}
        aria-label={`查看 ${project.name} 的运行详情`}
      >
        <div className="card-topline">
          <div className="card-badges">
            <span className="badge badge-stage">{STAGES[project.stage] || project.stage}</span>
            <span className="badge badge-status">{copy.eyebrow}</span>
          </div>
          <time className="card-time">{formatTime(confirmedAt)}</time>
        </div>

        <h4 className="card-name">{project.name}</h4>
        <div className="card-status-title">{copy.title}</div>
        <p className="card-status-desc">{copy.detail}</p>
        <span className="card-detail-hint">查看运行详情 <span aria-hidden="true">→</span></span>
      </button>

      <div className="card-actions-row">
        <span className="card-agent">{agent ? `当前 AI · ${agent}` : '当前没有 AI 会话'}</span>
        {isDisabled ? (
          <span className="read-only-action">{actionLabel}</span>
        ) : (
          <button
            type="button"
            className="btn btn-card-action"
            onClick={(event) => {
              event.stopPropagation();
              onAction(project);
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </article>
  );
}

function ProjectDetailModal({ state, onClose, onRetry, onLoadOlder }) {
  const modalRef = useFocusTrap(true, onClose);
  const project = state.data?.project ?? state.seed;
  const statusReason = getProjectStatusReason(project);
  const statusCopy = STATUS[statusReason] ?? STATUS.ready_to_start;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div
      className="modal-backdrop project-detail-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className={`project-detail-dialog status-theme-${getProjectTheme(project)}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-detail-title"
        tabIndex="-1"
      >
        <header className="project-detail-header">
          <div className="project-detail-heading">
            <div className="detail-kicker-row">
              <span className="badge badge-stage">{STAGES[project.stage] || project.stage}</span>
              <span className="badge badge-status">{statusCopy.eyebrow}</span>
            </div>
            <h2 id="project-detail-title">{project.name}</h2>
            <p>{statusCopy.title}</p>
          </div>
          <button type="button" className="detail-close-btn" onClick={onClose} aria-label="关闭项目详情">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="project-detail-scroll">
          {state.loading ? (
            <DetailLoadingState />
          ) : state.error && !state.data ? (
            <DetailErrorState notice={state.error} onRetry={onRetry} />
          ) : (
            <ProjectDetailContent
              data={state.data}
              loadingMore={state.loadingMore}
              loadError={state.error}
              onLoadOlder={onLoadOlder}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function DetailLoadingState() {
  return (
    <div className="detail-loading" role="status">
      <span className="detail-loading-line detail-loading-line-wide" />
      <span className="detail-loading-line" />
      <span className="detail-loading-line detail-loading-line-short" />
      <p>正在整理项目运行详情…</p>
    </div>
  );
}

function DetailErrorState({ notice, onRetry }) {
  return (
    <div className="detail-error" role="alert">
      <span className="detail-error-mark" aria-hidden="true">!</span>
      <h3>{notice.message}</h3>
      {notice.impact && <p>{notice.impact}</p>}
      {notice.required_action && <p>{notice.required_action}</p>}
      <button type="button" className="btn btn-secondary" onClick={onRetry}>重新读取详情</button>
    </div>
  );
}

function ProjectDetailContent({ data, loadingMore, loadError, onLoadOlder }) {
  const { project, timeline } = data;
  const git = project.git ?? {};
  const sessionId = project.activeWork?.sessionId ?? project.activeRun?.id ?? null;
  const revision = project.activeWork?.revision ?? project.activeRun?.revision ?? null;

  return (
    <>
      <section className="project-facts" aria-label="项目当前信息">
        <div className="fact-card fact-card-git">
          <span className="fact-label">当前代码位置</span>
          <strong>{git.branch || '分支未记录'}</strong>
          <span className="fact-detail">{git.shortHead ? `提交 ${git.shortHead}` : '提交未记录'}</span>
        </div>
        <div className="fact-card">
          <span className="fact-label">本地文件</span>
          <strong>{git.hasChanges ? '有尚未归属的改动' : '与最近检查一致'}</strong>
          <span className="fact-detail">{git.coherence === 'coherent' ? '代码状态已确认' : '等待再次确认'}</span>
        </div>
        <div className="fact-card">
          <span className="fact-label">当前 AI</span>
          <strong>{project.currentAgent || '没有进行中的会话'}</strong>
          <span className="fact-detail">{project.currentGoal || '尚未设置工作目标'}</span>
        </div>
        <div className="fact-card">
          <span className="fact-label">最近确认</span>
          <strong>{formatTime(project.lastObservedAt)}</strong>
          <span className="fact-detail">来自 Cockpit 的只读检查</span>
        </div>
      </section>

      <details className="project-tech-panel">
        <summary>技术详情</summary>
        <dl>
          <div><dt>代码位置</dt><dd>{project.path}</dd></div>
          <div><dt>项目 ID</dt><dd>{project.id}</dd></div>
          {sessionId && <div><dt>会话 ID</dt><dd>{sessionId}</dd></div>}
          {revision !== null && <div><dt>Revision</dt><dd>{revision}</dd></div>}
        </dl>
      </details>

      <section className="timeline-section" aria-labelledby="timeline-title">
        <div className="timeline-heading">
          <div>
            <span className="timeline-overline">WORK HISTORY</span>
            <h3 id="timeline-title">运行节点</h3>
            <p>最新确认的节点在上方；只展示有意义的工作动作。</p>
          </div>
          <span className="timeline-count">{timeline.total} 个节点</span>
        </div>

        {timeline.items.length === 0 ? (
          <div className="timeline-empty">
            <span aria-hidden="true" />
            <h4>还没有运行节点</h4>
            <p>项目接入 AI 后，重要进展会从这里开始记录。</p>
          </div>
        ) : (
          <ol className="project-timeline" aria-label="最新在上的项目运行节点">
            {timeline.items.map((item, index) => (
              <TimelineNode key={`${item.kind}-${item.id}`} item={item} index={index} />
            ))}
          </ol>
        )}

        {loadError && timeline.items.length > 0 && (
          <p className="timeline-load-error" role="alert">{loadError.message} 已显示的节点不受影响。</p>
        )}
        {timeline.hasMore && (
          <div className="timeline-load-more">
            <button type="button" className="btn btn-secondary" onClick={onLoadOlder} disabled={loadingMore}>
              {loadingMore ? '正在加载…' : '加载更早记录'}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function TimelineNode({ item, index }) {
  const kind = TIMELINE_KINDS[item.kind] ?? { code: 'EVENT', label: item.typeLabel || '运行节点' };
  const detailGroups = [
    ['已完成', item.completedItems],
    ['待继续', item.pendingItems],
    ['关键决定', item.decisions],
    ['风险', item.risks],
  ].filter(([, values]) => Array.isArray(values) && values.length > 0);

  return (
    <li
      className={`timeline-node timeline-node-${item.kind}`}
      style={{ '--timeline-index': Math.min(index, 9) }}
    >
      <div className="timeline-rail" aria-hidden="true"><span /></div>
      <article className="timeline-bubble">
        <header className="timeline-node-header">
          <div className="timeline-kind-wrap">
            <span className="timeline-kind-code">{kind.code}</span>
            <strong>{kind.label}</strong>
          </div>
          <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
        </header>

        <div className="timeline-context-row">
          <span className="timeline-agent">AI · {item.agent || '未记录'}</span>
          {item.git ? (
            <>
              {item.git.branch && <span className="git-chip git-branch">{item.git.branch}</span>}
              {item.git.shortHead && <span className="git-chip git-commit">{item.git.shortHead}</span>}
            </>
          ) : (
            <span className="git-unrecorded">当时分支未记录</span>
          )}
        </div>

        {item.git?.branchChanged && (
          <div className="branch-change-note">
            分支从 <code>{item.git.previousBranch}</code> 切换到 <code>{item.git.branch}</code>
          </div>
        )}

        <h4>{item.summary || item.note || kind.label}</h4>
        {item.currentState && item.currentState !== item.summary && (
          <p className="timeline-current-state"><span>当前状态</span>{item.currentState}</p>
        )}

        {detailGroups.length > 0 && (
          <div className="timeline-detail-groups">
            {detailGroups.map(([label, values]) => (
              <section key={label}>
                <h5>{label}</h5>
                <ul>{values.map((value, valueIndex) => <li key={`${label}-${valueIndex}`}>{value}</li>)}</ul>
              </section>
            ))}
          </div>
        )}

        {item.nextSessionFocus && (
          <div className="timeline-next-focus"><span>下一步</span>{item.nextSessionFocus}</div>
        )}

        {item.bodyMarkdown && (
          <details className="timeline-full-record">
            <summary>查看完整交接记录</summary>
            <pre>{item.bodyMarkdown}</pre>
          </details>
        )}
      </article>
    </li>
  );
}

function ConfirmAddModal({ selection, onClose, onRegister, busy, notice }) {
  const [name, setName] = useState(selection?.folderName || '');
  const [stage, setStage] = useState('development');
  const modalRef = useFocusTrap(Boolean(selection), onClose, busy);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-folder-title"
        tabIndex="-1"
      >
        <div className="modal-header">
          <div>
            <span className="badge badge-modal-kicker">安全确认 · 添加代码位置</span>
            <h2 id="confirm-folder-title" className="modal-title">我们只会添加这一份代码</h2>
          </div>
          <button
            type="button"
            className="modal-close-icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="selection-info-box">
            <span className="info-label">已选择文件夹</span>
            <strong className="info-value">{selection.folderName}</strong>
          </div>

          <div className="safety-promise-card">
            <div className="safety-badge">安全边界保证</div>
            <p className="safety-promise-text">{selection.promise}</p>
          </div>

          <div className="form-field">
            <label htmlFor="modal-project-name" className="field-label">项目显示名称</label>
            <input
              id="modal-project-name"
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              maxLength="100"
            />
          </div>

          <div className="form-field">
            <label htmlFor="modal-project-stage" className="field-label">当前阶段</label>
            <select
              id="modal-project-stage"
              className="field-select"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              disabled={busy}
            >
              <option value="development">开发中</option>
              <option value="maintenance">已经上线，只做日常维护</option>
              <option value="paused">暂时放下</option>
            </select>
          </div>

          <details className="tech-details modal-tech-details">
            <summary>查看技术位置</summary>
            <code>{selection.folderPath}</code>
          </details>

          {notice && <NoticeBanner notice={notice} busy={busy} />}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onRegister(name, stage)}
            disabled={busy || !name.trim()}
          >
            {busy ? '正在安全检查…' : '确认添加'}
          </button>
        </div>
      </section>
    </div>
  );
}

function HandoffModal({
  project,
  agent,
  setAgent,
  goal,
  setGoal,
  dispatch,
  busy,
  notice,
  onClose,
  onCreate,
  onCopy,
}) {
  const modalRef = useFocusTrap(Boolean(project), onClose, busy);
  const isAdoptMode = project?.pendingAssignment?.mode === 'adopt';

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-dialog-title"
        tabIndex="-1"
      >
        <div className="modal-header">
          <div>
            <span className="badge badge-modal-kicker">
              {dispatch ? '接入指令已就绪' : (isAdoptMode ? '重新生成接入指令' : '交给 AI')}
            </span>
            <h2 id="handoff-dialog-title" className="modal-title">
              {isAdoptMode ? `${project.name} · 重新生成接入指令` : project.name}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {!dispatch ? (
            <>
              {isAdoptMode && (
                <div className="info-alert-box">
                  <p>该项目已有待接手的初始化任务，将为你重新生成有效的接入指令。</p>
                </div>
              )}

              <div className="form-field">
                <label htmlFor="modal-agent-select" className="field-label">交给哪位 AI Agent</label>
                <select
                  id="modal-agent-select"
                  className="field-select"
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                  disabled={busy}
                >
                  <option value="Codex">Codex</option>
                  <option value="ZCode">ZCode</option>
                  <option value="Antigravity">Antigravity</option>
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="modal-goal-textarea" className="field-label">
                  {isAdoptMode ? '本次任务目标（保留原目标）' : '本次任务目标（可选）'}
                </label>
                <textarea
                  id="modal-goal-textarea"
                  className="field-textarea"
                  value={goal}
                  onChange={(e) => {
                    if (!isAdoptMode) setGoal(e.target.value);
                  }}
                  rows="3"
                  maxLength="1000"
                  placeholder="可以留空；例如：完成登录页的接口联调与异常处理"
                  disabled={busy}
                  readOnly={isAdoptMode}
                  aria-describedby={isAdoptMode ? 'reissue-goal-hint' : undefined}
                />
                {isAdoptMode && (
                  <p id="reissue-goal-hint" className="field-hint">
                    重新生成只更新一次性接入码和接手 Agent；原任务目标保持不变。
                  </p>
                )}
              </div>

              {project.lastHandoffManual && (
                <div className="handoff-ref-box">
                  <div className="ref-title">上次交接参考</div>
                  <p className="ref-summary">{project.lastHandoffManual.summary}</p>
                  {project.lastHandoffManual.nextSessionFocus && (
                    <div className="ref-next">
                      <strong>建议下一步：</strong>{project.lastHandoffManual.nextSessionFocus}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="success-alert-box">
                <p>
                  接入指令已创建。请复制下方消息发送给 <strong>{agent}</strong>。
                  MCP 客户端连接成功后，控制台会自动刷新为“会话已接入”状态。
                </p>
              </div>

              <div className="form-field">
                <label htmlFor="modal-dispatch-msg" className="field-label">接入消息指令</label>
                <textarea
                  id="modal-dispatch-msg"
                  className="field-textarea dispatch-message"
                  value={dispatch.message}
                  readOnly
                  rows="8"
                />
              </div>

              <div className="expiry-hint">
                接手码有效期至 <strong>{formatTime(dispatch.expiresAt)}</strong>。消息中不包含本地物理路径或主 API 密钥。
              </div>
            </>
          )}

          {notice && <NoticeBanner notice={notice} busy={busy} />}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            {dispatch ? '完成' : '取消'}
          </button>
          {!dispatch ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onCreate}
              disabled={busy}
            >
              {busy
                ? (isAdoptMode ? '正在重新生成…' : '正在创建…')
                : (isAdoptMode ? '重新生成接入指令' : '生成接入指令')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onCopy}
            >
              复制接手消息
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
