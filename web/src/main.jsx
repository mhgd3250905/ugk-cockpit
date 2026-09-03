import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api.js';
import { SUBMIT_MESSAGE, deliveryStatusLabel } from './delivery-view.mjs';
import {
  timelineCurvePath,
  timelineCurveSourceY,
  timelineRailEndY,
} from './timeline-geometry.mjs';
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
  integration: { code: 'INTEGRATED', label: '接入主项目' },
};

const TIMELINE_SPACE_COLORS = [
  'var(--timeline-space-line)',
  'var(--timeline-space-alt-line)',
  'var(--timeline-space-third-line)',
];

function stableLaneColor(lane) {
  if (lane.role === 'main') return 'var(--timeline-main-line)';
  if (lane.role === 'unknown') return 'var(--timeline-unknown-line)';
  const key = String(lane.key || lane.spaceId || lane.worktreeId || 'space');
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return TIMELINE_SPACE_COLORS[Math.abs(hash) % TIMELINE_SPACE_COLORS.length];
}

function timelineTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getTimelineLanes(timeline, items = []) {
  const lanes = [];
  const known = new Map();
  const supplied = Array.isArray(timeline?.lanes) ? timeline.lanes : [];

  for (const lane of supplied) {
    if (!lane?.key || known.has(lane.key)) continue;
    const normalized = {
      key: lane.key,
      role: lane.role || 'unknown',
      label: lane.label || '来源未确认',
      worktreeId: lane.worktreeId ?? null,
      spaceId: lane.spaceId ?? null,
      origin: lane.origin ?? null,
      eventCount: Number(lane.eventCount ?? 0),
    };
    known.set(normalized.key, normalized);
    lanes.push(normalized);
  }

  for (const item of items) {
    const key = item?.laneKey || 'unknown';
    if (known.has(key)) continue;
    const normalized = {
      key,
      role: item?.laneRole || 'unknown',
      label: item?.laneLabel || '来源未确认',
      worktreeId: item?.worktreeId ?? null,
      spaceId: item?.spaceId ?? null,
      origin: null,
      eventCount: 0,
    };
    known.set(key, normalized);
    lanes.push(normalized);
  }

  if (lanes.length === 0) {
    lanes.push({
      key: 'unknown',
      role: 'unknown',
      label: '来源未确认',
      worktreeId: null,
      spaceId: null,
      origin: null,
      eventCount: 0,
    });
  }

  return lanes.map((lane, index) => ({
    ...lane,
    index,
    color: stableLaneColor(lane),
  }));
}

function getTimelineEntries(timeline, lanes) {
  const items = Array.isArray(timeline?.items) ? timeline.items : [];
  const entries = items.map((item) => ({ ...item, entryKind: 'event' }));
  const oldestItemTime = items.reduce((oldest, item) => {
    const timestamp = timelineTimestamp(item.timestamp);
    return oldest === null || timestamp < oldest ? timestamp : oldest;
  }, null);

  for (const lane of lanes) {
    const origin = lane.origin;
    if (lane.role !== 'development_space' || !origin?.createdAt) continue;
    const originTime = timelineTimestamp(origin.createdAt);
    const originOutsideLoadedWindow = Boolean(
      timeline?.hasMore && oldestItemTime !== null && originTime < oldestItemTime,
    );
    entries.push({
      id: `origin:${lane.key}`,
      entryKind: originOutsideLoadedWindow ? 'origin-continuation' : 'origin',
      kind: 'origin',
      laneKey: lane.key,
      laneLabel: lane.label,
      laneRole: lane.role,
      timestamp: origin.createdAt,
      origin,
      originOutsideLoadedWindow,
      summary: `开发空间已创建 · ${lane.label}`,
    });
  }

  return entries.sort((left, right) => {
    const timeDiff = timelineTimestamp(right.timestamp) - timelineTimestamp(left.timestamp);
    if (timeDiff !== 0) return timeDiff;
    // At the same timestamp, show the actual event before its source row.
    if (left.entryKind !== right.entryKind) return left.entryKind === 'event' ? -1 : 1;
    return String(right.id).localeCompare(String(left.id));
  });
}

const THEME_OPTIONS = [
  { mode: 'light', label: '亮色', icon: SunIcon },
  { mode: 'dark', label: '暗色', icon: MoonIcon },
  { mode: 'system', label: '跟随系统', icon: SystemIcon },
];

const THEME_STORAGE_KEY = 'ugk-cockpit-theme';

function useTheme() {
  const [mode, setMode] = useState(() => {
    if (typeof window !== 'undefined' && typeof window.__ugkGetThemeMode === 'function') {
      return window.__ugkGetThemeMode();
    }
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {
      // Storage unavailable: default to dark.
    }
    return 'dark';
  });

  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.__ugkSetTheme === 'function') {
      window.__ugkSetTheme(mode);
    }
  }, [mode]);

  return [mode, setMode];
}

const PROJECT_ROUTE_PREFIX = '#/projects/';

function readAppRoute() {
  if (typeof window === 'undefined') return { kind: 'list', projectId: null };
  const hash = window.location.hash || '';
  if (!hash.startsWith(PROJECT_ROUTE_PREFIX)) return { kind: 'list', projectId: null };

  const encodedId = hash.slice(PROJECT_ROUTE_PREFIX.length).replace(/\/+$/, '');
  if (!encodedId) return { kind: 'detail', projectId: null, invalid: true };
  try {
    const projectId = decodeURIComponent(encodedId);
    return projectId
      ? { kind: 'detail', projectId, invalid: false }
      : { kind: 'detail', projectId: null, invalid: true };
  } catch {
    return { kind: 'detail', projectId: null, invalid: true };
  }
}

function useAppRoute() {
  const [route, setRoute] = useState(readAppRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readAppRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

function navigateToProject(projectId) {
  if (!projectId) return;
  window.location.hash = `${PROJECT_ROUTE_PREFIX}${encodeURIComponent(projectId)}`;
}

function navigateToProjectList() {
  if (window.location.hash) window.location.hash = '';
}

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

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function LogoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 17V7l8 10V7" />
      <path d="M18 17h3" />
    </svg>
  );
}

function ThemeSwitch({ mode, onChange }) {
  return (
    <div className="theme-switch" role="group" aria-label="界面主题">
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.mode}
            type="button"
            className="theme-switch-btn"
            aria-pressed={mode === option.mode}
            onClick={() => onChange(option.mode)}
          >
            <Icon />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function calculateRefreshLimit(currentCount) {
  const count = typeof currentCount === 'number' && Number.isFinite(currentCount) ? currentCount : 30;
  return Math.min(100, Math.max(30, Math.floor(count)));
}

export function getRelayStateInfo(item) {
  if (!item || item.kind !== 'relay') return null;
  if (item.state === 'accepted') {
    return {
      state: 'accepted',
      label: '新会话已接手',
      acceptedAt: item.acceptedAt ?? null,
      statusTheme: 'accepted',
    };
  }
  if (item.state === 'expired') {
    return {
      state: 'expired',
      label: '接力已过期',
      acceptedAt: null,
      statusTheme: 'expired',
    };
  }
  return {
    state: 'active',
    label: '等待新会话接手',
    acceptedAt: null,
    statusTheme: 'active',
  };
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
  const route = useAppRoute();
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
  const [themeMode, setThemeMode] = useTheme();
  const detailRequestRef = useRef(0);
  const projectDetailRef = useRef(projectDetail);
  const dashboardRef = useRef(dashboard);
  const activeDetailProjectId = route.kind === 'detail' && !route.invalid
    ? route.projectId
    : null;

  useEffect(() => {
    projectDetailRef.current = projectDetail;
  }, [projectDetail]);

  useEffect(() => {
    dashboardRef.current = dashboard;
  }, [dashboard]);

  function isCurrentDetailRequest(requestId, projectId) {
    const currentRoute = readAppRoute();
    return detailRequestRef.current === requestId
      && currentRoute.kind === 'detail'
      && !currentRoute.invalid
      && currentRoute.projectId === projectId;
  }

  function beginProjectDetailLoad(projectId, seed = null) {
    const requestId = ++detailRequestRef.current;
    const fallbackSeed = seed ?? {
      id: projectId,
      name: '项目详情',
      stage: 'development',
    };
    setProjectDetail({
      seed: fallbackSeed,
      data: null,
      loading: true,
      loadingMore: false,
      error: null,
      requestId,
    });

    api(`/api/v1/projects/${encodeURIComponent(projectId)}?limit=30&offset=0`)
      .then((data) => {
        if (!isCurrentDetailRequest(requestId, projectId)) return;
        setProjectDetail((previous) => {
          if (!previous || previous.requestId !== requestId || previous.seed.id !== projectId) {
            return previous;
          }
          return {
            ...previous,
            data,
            loading: false,
            error: null,
          };
        });
      })
      .catch((error) => {
        if (!isCurrentDetailRequest(requestId, projectId)) return;
        setProjectDetail((previous) => {
          if (!previous || previous.requestId !== requestId || previous.seed.id !== projectId) {
            return previous;
          }
          return {
            ...previous,
            loading: false,
            error: createErrorNotice(error, {
              message: '暂时没有读到项目运行详情。',
              impact: '项目代码和已有工作记录不受影响。',
              requiredAction: '请确认本机服务已更新，然后重试读取。',
            }),
          };
        });
      });
  }

  useEffect(() => {
    if (route.kind !== 'detail') {
      detailRequestRef.current += 1;
      setProjectDetail(null);
      return;
    }

    if (route.invalid) {
      const requestId = ++detailRequestRef.current;
      setProjectDetail({
        seed: { id: '', name: '项目详情', stage: 'development' },
        data: null,
        loading: false,
        loadingMore: false,
        requestId,
        error: {
          message: '项目链接无效。',
          impact: '没有读取或修改任何项目记录。',
          required_action: '请返回项目列表后重新选择项目。',
        },
      });
      return;
    }

    const seed = dashboardRef.current?.projects?.find((item) => item.id === route.projectId) ?? null;
    beginProjectDetailLoad(route.projectId, seed);
  }, [route.kind, route.projectId, route.invalid]);

  useEffect(() => {
    if (!activeDetailProjectId) return;

    async function pollProjectDetail() {
      const current = projectDetailRef.current;
      if (!current || current.seed.id !== activeDetailProjectId || current.loadingMore) return;
      const count = current.data?.timeline?.items?.length ?? 30;
      const limit = calculateRefreshLimit(count);
      const requestId = current.requestId;
      try {
        const data = await api(
          `/api/v1/projects/${encodeURIComponent(activeDetailProjectId)}?limit=${limit}&offset=0`
        );
        if (!isCurrentDetailRequest(requestId, activeDetailProjectId)) return;
        setProjectDetail((prev) => {
          if (
            !prev
            || prev.requestId !== requestId
            || prev.seed.id !== activeDetailProjectId
            || prev.loadingMore
          ) return prev;
          const visibleCount = prev.data?.timeline?.items?.length ?? 0;
          if (visibleCount > limit) return prev;
          return {
            ...prev,
            data,
            loading: false,
            error: null,
          };
        });
      } catch {
        // Retain currently displayed content without overlaying error
      }
    }

    const timer = setInterval(pollProjectDetail, 4000);
    return () => clearInterval(timer);
  }, [activeDetailProjectId]);

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

  async function refreshOpenProjectDetail(actionNotice = null) {
    const current = projectDetailRef.current;
    if (!current) return;
    const projectId = current.seed.id;
    const requestId = current.requestId;
    if (!isCurrentDetailRequest(requestId, projectId)) return;
    const data = await api(`/api/v1/projects/${encodeURIComponent(projectId)}?limit=30&offset=0`);
    if (!isCurrentDetailRequest(requestId, projectId)) return;
    setProjectDetail((previous) => {
      if (!previous || previous.requestId !== requestId || previous.seed.id !== projectId) return previous;
      return {
        ...previous,
        data,
        loading: false,
        error: null,
        actionNotice,
      };
    });
  }

  async function createDevelopmentSpaceFromDetail() {
    const current = projectDetailRef.current;
    const project = current?.data?.project;
    const projectId = project?.id;
    const requestId = current?.requestId;
    if (!projectId || !project?.git?.head || !isCurrentDetailRequest(requestId, projectId)) return;
    setBusy(true);
    try {
      const selected = await api('/api/v1/folders/select-empty', { method: 'POST', body: '{}' });
      if (selected.cancelled || !isCurrentDetailRequest(requestId, projectId)) return;
      const refreshed = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/refresh`, {
        method: 'POST',
        body: JSON.stringify({ commandId: crypto.randomUUID() }),
      });
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      const result = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/spaces`, {
        method: 'POST',
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          grantId: selected.grantId,
          expectedBaseHead: refreshed.git.head,
          name: selected.folderName || '通用开发空间',
        }),
      });
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      await refreshOpenProjectDetail({
        message: `已创建 ${result.name || selected.folderName || '通用开发空间'}。`,
        detail: '代码已放入独立工作副本；主项目和已有改动没有被覆盖。',
      });
    } catch (error) {
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      setProjectDetail((previous) => previous ? {
        ...previous,
        ...(previous.requestId === requestId && previous.seed.id === projectId ? {
          actionNotice: {
            error: true,
            message: error.message || '开发空间还没有创建。',
            detail: error.required_action || '请保留当前目录并刷新后重试。',
          },
        } : {}),
      } : previous);
    } finally {
      setBusy(false);
    }
  }

  async function assignDevelopmentSpace(space) {
    const current = projectDetailRef.current;
    const project = current?.data?.project;
    const projectId = project?.id;
    const requestId = current?.requestId;
    if (!projectId || !isCurrentDetailRequest(requestId, projectId)) return;
    setBusy(true);
    try {
      const result = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/assignments`, {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          agent: 'Codex',
          mode: 'init',
          task: `在${space.name || '开发空间'}中继续功能开发`,
          spaceId: space.spaceId,
        }),
      });
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      await navigator.clipboard.writeText(result.message);
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      await refreshOpenProjectDetail({
        message: '开发空间接入消息已复制。',
        detail: '请把它粘贴给将在该代码位置工作的 Agent。',
      });
    } catch (error) {
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      setProjectDetail((previous) => previous ? {
        ...previous,
        ...(previous.requestId === requestId && previous.seed.id === projectId ? {
          actionNotice: {
            error: true,
            message: error.message || '还没有生成开发空间接入消息。',
            detail: error.required_action || '请刷新当前项目后重试。',
          },
        } : {}),
      } : previous);
    } finally {
      setBusy(false);
    }
  }

  async function copyIntegrationPrompt(submission) {
    const current = projectDetailRef.current;
    const projectId = current?.seed?.id;
    const requestId = current?.requestId;
    if (!submission.reviewPrompt || !projectId || !isCurrentDetailRequest(requestId, projectId)) return;
    try {
      await navigator.clipboard.writeText(submission.reviewPrompt);
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      setProjectDetail((previous) => previous ? {
        ...previous,
        ...(previous.requestId === requestId && previous.seed.id === projectId ? {
          actionNotice: {
            message: '审核提示词已复制。',
            detail: '请把它粘贴给主项目中的 Agent；平台会规范记录领取、审核与合并回执。',
          },
        } : {}),
      } : previous);
    } catch {
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      setProjectDetail((previous) => previous ? {
        ...previous,
        ...(previous.requestId === requestId && previous.seed.id === projectId ? {
          actionNotice: {
            error: true,
            message: '无法自动写入剪贴板。',
            detail: '请展开审核提示词并手动复制。',
          },
        } : {}),
      } : previous);
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

  function openProjectDetail(project) {
    navigateToProject(project.id);
  }

  function closeProjectDetail() {
    detailRequestRef.current += 1;
    navigateToProjectList();
    setProjectDetail(null);
  }

  function retryProjectDetail() {
    if (!activeDetailProjectId) return;
    const seed = projectDetailRef.current?.seed ?? null;
    beginProjectDetailLoad(activeDetailProjectId, seed);
  }

  async function loadOlderTimeline() {
    const detail = projectDetail;
    const timeline = detail?.data?.timeline;
    if (!detail || !timeline?.hasMore || detail.loadingMore) return;
    const projectId = detail.seed.id;
    const requestId = detail.requestId;
    if (!isCurrentDetailRequest(requestId, projectId)) return;
    setProjectDetail((current) => {
      if (!current || current.requestId !== requestId || current.seed.id !== projectId) return current;
      return { ...current, loadingMore: true };
    });
    try {
      const page = await api(
        `/api/v1/projects/${encodeURIComponent(projectId)}/timeline?limit=30&offset=${timeline.items.length}`
      );
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      setProjectDetail((current) => {
        if (
          !current
          || current.requestId !== requestId
          || current.seed.id !== projectId
          || !current.data
        ) return current;
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
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      setProjectDetail((current) => {
        if (!current || current.requestId !== requestId || current.seed.id !== projectId) return current;
        return {
          ...current,
          loadingMore: false,
          error: createErrorNotice(error, {
            message: '更早的节点暂时没有加载出来。',
            impact: '已显示的记录和项目代码不受影响。',
            requiredAction: '稍后可以再次尝试加载。',
          }),
        };
      });
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
              <span className="brand-mark" aria-hidden="true"><LogoIcon /></span>
              <h1 className="brand-title">UGK Cockpit</h1>
              <span className="badge badge-version">{__APP_VERSION__}</span>
            </div>
            <p className="brand-tagline">本机 AI 项目控制台</p>
          </div>

          <div className="header-actions">
            <ThemeSwitch mode={themeMode} onChange={setThemeMode} />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => refresh()}
              disabled={busy}
              title="重新加载简报数据"
            >
              <span className="btn-icon" aria-hidden="true"><RefreshIcon /></span> 重新加载简报
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => chooseFolder()}
              disabled={busy}
            >
              <span className="btn-icon" aria-hidden="true"><PlusIcon /></span> 选择项目文件夹
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
        {route.kind === 'detail' ? (
          <ProjectDetailPage
            state={route.invalid || projectDetail?.seed?.id !== activeDetailProjectId ? null : projectDetail}
            projectId={activeDetailProjectId}
            invalidRoute={route.invalid}
            onBack={closeProjectDetail}
            onRetry={retryProjectDetail}
            onLoadOlder={loadOlderTimeline}
            busy={busy}
            onCreateSpace={createDevelopmentSpaceFromDetail}
            onAssignSpace={assignDevelopmentSpace}
            onCopyReviewPrompt={copyIntegrationPrompt}
          />
        ) : (
          <>
            {notice && !selection && !handoffProject && (
              <NoticeBanner notice={notice} busy={busy} />
            )}

            {!dashboard ? (
              <LoadingState notice={notice} />
            ) : projects.length === 0 ? (
              <EmptyState busy={busy} onChoose={() => chooseFolder()} />
            ) : (
              groups.length > 0 && (
                <section className="projects-section" aria-label="项目矩阵">
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
          </>
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
  const showStage = project.stage && project.stage !== 'development';

  return (
    <article className={`project-card status-${theme}`}>
      <button
        type="button"
        className="card-open"
        onClick={() => onOpen(project)}
        aria-label={`查看 ${project.name} 的运行详情`}
      >
        <div className="card-eyebrow">
          <span className="card-status-badge">{copy.eyebrow}</span>
          <time className="card-time">{formatTime(confirmedAt)}</time>
        </div>

        <h4 className="card-name">{project.name}</h4>
        {showStage && <span className="badge badge-stage">{STAGES[project.stage] || project.stage}</span>}
        <p className="card-what">{copy.title}</p>
        <p className="card-impact">{copy.detail}</p>
      </button>

      <footer className="card-foot">
        <span className="card-agent">{agent ? `${agent}` : '暂无 AI 会话'}</span>
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
      </footer>
    </article>
  );
}

function ProjectDetailPage({ state, projectId, invalidRoute, onBack, onRetry, onLoadOlder, busy, onCreateSpace, onAssignSpace, onCopyReviewPrompt }) {
  const titleRef = useRef(null);
  const project = state?.data?.project ?? state?.seed ?? {
    name: '项目详情',
    stage: 'development',
  };
  const statusReason = getProjectStatusReason(project);
  const statusCopy = STATUS[statusReason] ?? STATUS.ready_to_start;
  const headingCopy = state?.loading
    ? '正在读取项目运行详情…'
    : state?.error && !state?.data
      ? '项目详情暂时不可用'
      : statusCopy.title;
  const eyebrow = state?.loading
    ? '正在读取'
    : state?.error && !state?.data
      ? '读取失败'
      : statusCopy.eyebrow;
  const invalidNotice = {
    message: '项目链接无效。',
    impact: '没有读取或修改任何项目记录。',
    required_action: '请返回项目列表后重新选择项目。',
  };

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [projectId, invalidRoute]);

  return (
    <section
      className={`project-detail-page status-${getProjectTheme(project)}`}
      aria-labelledby="project-detail-title"
    >
      <header className="project-detail-header">
        <div className="project-detail-heading">
          <button type="button" className="detail-back-link" onClick={onBack}>
            ← 返回项目列表
          </button>
          <div className="detail-kicker-row">
            {project.stage && <span className="badge badge-stage">{STAGES[project.stage] || project.stage}</span>}
            <span className="badge badge-status">{eyebrow}</span>
          </div>
          <h2 id="project-detail-title" ref={titleRef} tabIndex="-1">{project.name}</h2>
          <p>{headingCopy}</p>
        </div>
      </header>

      <div className="project-detail-content">
        {invalidRoute ? (
          <DetailErrorState notice={invalidNotice} onRetry={onBack} retryLabel="返回项目列表" />
        ) : !state || state.loading ? (
          <DetailLoadingState />
        ) : state.error && !state.data ? (
          <DetailErrorState notice={state.error} onRetry={onRetry} />
        ) : state.data ? (
          <ProjectDetailContent
            data={state.data}
            loadingMore={state.loadingMore}
            loadError={state.error}
            onLoadOlder={onLoadOlder}
            actionNotice={state.actionNotice}
            busy={busy}
            onCreateSpace={onCreateSpace}
            onAssignSpace={onAssignSpace}
            onCopyReviewPrompt={onCopyReviewPrompt}
          />
        ) : (
          <DetailErrorState
            notice={{
              message: '项目详情暂时没有数据。',
              impact: '项目代码和已有工作记录不受影响。',
              required_action: '请返回项目列表后重试。',
            }}
            onRetry={onBack}
            retryLabel="返回项目列表"
          />
        )}
      </div>
    </section>
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

function DetailErrorState({ notice, onRetry, retryLabel = '重新读取详情' }) {
  return (
    <div className="detail-error" role="alert">
      <span className="detail-error-mark" aria-hidden="true">!</span>
      <h3>{notice.message}</h3>
      {notice.impact && <p>{notice.impact}</p>}
      {notice.required_action && <p>{notice.required_action}</p>}
      <button type="button" className="btn btn-secondary" onClick={onRetry}>{retryLabel}</button>
    </div>
  );
}

function SubmitHelp() {
  const [copied, setCopied] = useState(false);
  return <details className="review-prompt-fallback">
    <summary>外部或已有分支如何送审？</summary>
    <p>无论是否提前接入过平台，都可以在完成功能的会话中调用 cockpit-submit。首次访问新目录会请你选择文件夹授权。</p>
    <button type="button" className="btn btn-secondary btn-sm" onClick={async () => {
      try { await navigator.clipboard.writeText(SUBMIT_MESSAGE); setCopied(true); }
      catch { setCopied(false); }
    }}>{copied ? '送审消息已复制' : '复制分支送审消息'}</button>
    <pre>{SUBMIT_MESSAGE}</pre>
    <p>外部机器无法连接本机平台时，交付消息只表示“待接入”，不能当作平台已收到。</p>
  </details>;
}

function ProjectDetailContent({ data, loadingMore, loadError, onLoadOlder, actionNotice, busy, onCreateSpace, onAssignSpace, onCopyReviewPrompt }) {
  const { project, timeline, developmentSpaces = [], submissions = [] } = data;
  const git = project.git ?? {};
  const sessionId = project.activeWork?.sessionId ?? project.activeRun?.id ?? null;
  const revision = project.activeWork?.revision ?? project.activeRun?.revision ?? null;
  const [focusedLaneKey, setFocusedLaneKey] = useState(null);
  const timelineItems = Array.isArray(timeline?.items) ? timeline.items : [];
  const timelineLanes = useMemo(() => getTimelineLanes(timeline, timelineItems), [timeline, timelineItems]);
  const timelineEntries = useMemo(
    () => getTimelineEntries(timeline, timelineLanes),
    [timeline, timelineLanes],
  );

  useEffect(() => {
    if (focusedLaneKey && !timelineLanes.some((lane) => lane.key === focusedLaneKey)) {
      setFocusedLaneKey(null);
    }
  }, [focusedLaneKey, timelineLanes]);

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

      {actionNotice && (
        <div className={`detail-action-notice${actionNotice.error ? ' is-error' : ''}`} role="status">
          <strong>{actionNotice.message}</strong>
          {actionNotice.detail && <span>{actionNotice.detail}</span>}
        </div>
      )}

      <section className="workspace-section" aria-labelledby="workspace-title">
        <div className="workspace-heading">
          <div>
            <span className="timeline-overline">DEVELOPMENT SPACES</span>
            <h3 id="workspace-title">功能开发空间</h3>
            <p>每个空间独立承载一项功能；你只需选择一个空文件夹。</p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCreateSpace} disabled={busy}>
            {busy ? '正在处理…' : '新建开发空间'}
          </button>
        </div>
        {developmentSpaces.length === 0 ? (
          <p className="workspace-empty">还没有开发空间。需要并行做功能时再创建即可。</p>
        ) : (
          <div className="workspace-list">
            {developmentSpaces.map((space) => (
              <article className="workspace-card" key={space.spaceId}>
                <div>
                  <strong>{space.name}</strong>
                  <span>{space.status === 'awaiting_review' ? '等待主项目审核' : space.status === 'cleanup_ready' ? '已接入主项目，可稍后整理' : '可以继续开发'}</span>
                </div>
                {space.status === 'ready' && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAssignSpace(space)} disabled={busy}>
                    复制接入消息
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="review-section" aria-labelledby="review-title">
        <div className="workspace-heading">
          <div>
            <span className="timeline-overline">MAIN REVIEW</span>
            <h3 id="review-title">主项目待办</h3>
            <p>功能送达后，从这里复制标准审核提示词。</p>
          </div>
        </div>
        <SubmitHelp />
        {submissions.length === 0 ? (
          <p className="workspace-empty">当前没有等待处理的功能。</p>
        ) : (
          <div className="workspace-list">
            {submissions.map((submission) => (
              <article className="workspace-card review-card" key={submission.submissionId}>
                <div>
                  <strong>{submission.title || submission.spaceName}</strong>
                  <span>{deliveryStatusLabel(submission)}</span>
                  {submission.sourceBranch && <span>工作线：{submission.sourceBranch} · 第 {submission.deliveryVersion ?? 1} 次交付</span>}
                  {submission.fastForward === false && submission.status === 'pending' && <span>未发现文件冲突；接入前仍需处理主项目版本衔接。</span>}
                  {submission.conflicts?.length > 0 && <details><summary>查看冲突文件（{submission.conflicts.length}）</summary><ul>{submission.conflicts.map((file) => <li key={file}>{file}</li>)}</ul></details>}
                  {submission.pullRequestUrl && <a href={submission.pullRequestUrl} target="_blank" rel="noopener noreferrer">查看关联 PR（状态尚未核验）</a>}
                </div>
                {submission.reviewPrompt && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onCopyReviewPrompt(submission)}>
                    复制审核提示词
                  </button>
                )}
                {submission.reviewPrompt && (
                  <details className="review-prompt-fallback">
                    <summary>手动复制</summary>
                    <pre>{submission.reviewPrompt}</pre>
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="timeline-section" aria-labelledby="timeline-title">
        <div className="timeline-heading">
          <div>
            <span className="timeline-overline">WORK HISTORY</span>
            <h3 id="timeline-title">运行节点</h3>
            <p>最新确认的节点在上方；工作副本沿各自工作线延续。</p>
          </div>
          <span className="timeline-count">{timeline.total} 个节点</span>
        </div>

        <TimelineLaneControls
          lanes={timelineLanes}
          focusedLaneKey={focusedLaneKey}
          onFocusLane={setFocusedLaneKey}
        />

        {timelineEntries.length === 0 ? (
          <div className="timeline-empty">
            <span aria-hidden="true" />
            <h4>还没有运行节点</h4>
            <p>项目接入 AI 后，重要进展会从这里开始记录。</p>
          </div>
        ) : (
          <TimelineHistory
            entries={timelineEntries}
            lanes={timelineLanes}
            focusedLaneKey={focusedLaneKey}
            onFocusLane={setFocusedLaneKey}
          />
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

function TimelineLaneControls({ lanes, focusedLaneKey, onFocusLane }) {
  const visibleLanes = lanes.filter((lane) => (
    lane.eventCount > 0 || lane.origin?.createdAt || lane.role === 'main'
  ));

  return (
    <div className="timeline-lane-controls" role="toolbar" aria-label="选择要突出显示的工作线">
      <div className="timeline-lane-filters">
        {visibleLanes.map((lane) => (
          <button
            type="button"
            className="timeline-lane-filter"
            key={lane.key}
            style={{ '--timeline-lane-color': lane.color }}
            aria-pressed={focusedLaneKey === lane.key}
            onClick={() => onFocusLane(lane.key)}
          >
            <span className="timeline-lane-swatch" aria-hidden="true" />
            <span>{lane.label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="timeline-focus-clear"
        aria-pressed={focusedLaneKey === null}
        onClick={() => onFocusLane(null)}
      >
        显示全部
      </button>
      <span className="timeline-focus-status" role="status" aria-live="polite">
        {focusedLaneKey
          ? `已突出显示${lanes.find((lane) => lane.key === focusedLaneKey)?.label || '所选'}工作线`
          : '全部工作线'}
      </span>
    </div>
  );
}

function timelineEntryKey(entry) {
  return entry.entryKind === 'origin' || entry.entryKind === 'origin-continuation'
    ? `origin:${entry.laneKey}`
    : `event:${entry.kind}:${entry.id}`;
}

function timelineRailWidth(laneCount, contentWidth) {
  const narrow = contentWidth <= 560;
  const min = narrow ? 52 : 72;
  const max = narrow ? 108 : 132;
  const step = narrow ? 17 : 22;
  const padding = narrow ? 16 : 20;
  return Math.min(max, Math.max(min, laneCount * step + padding));
}

function timelineLaneX(lane, laneCount, railWidth) {
  if (laneCount <= 1) return railWidth / 2;
  const edge = Math.min(18, Math.max(11, railWidth / (laneCount + 1)));
  return edge + ((railWidth - edge * 2) * lane.index) / (laneCount - 1);
}

function TimelineGraph({ geometry, entries, lanes, focusedLaneKey }) {
  if (!geometry) return null;

  const laneByKey = new Map(lanes.map((lane) => [lane.key, lane]));
  const mainLane = lanes.find((lane) => lane.role === 'main') || lanes[0];
  const activeLaneKeys = new Set(entries.flatMap((entry) => [entry.laneKey, entry.sourceLaneKey].filter(Boolean)));
  const focusOpacity = (laneKey) => (
    focusedLaneKey && focusedLaneKey !== laneKey ? 0.28 : 1
  );
  const paths = [];

  for (const lane of lanes) {
    if (!activeLaneKeys.has(lane.key)) continue;
    const x = geometry.laneX.get(lane.key);
    if (x === undefined) continue;
    const railEndY = geometry.railEndY.get(lane.key) ?? Math.max(3, geometry.height - 3);
    paths.push(
      <path
        key={`rail:${lane.key}`}
        className="timeline-graph-rail"
        d={`M ${x} 3 V ${railEndY}`}
        stroke={lane.color}
        style={{ opacity: focusOpacity(lane.key) }}
      />,
    );
  }

  for (const entry of entries) {
    const point = geometry.points.get(timelineEntryKey(entry));
    const lane = laneByKey.get(entry.laneKey);
    if (!point || !lane) continue;

    if (entry.entryKind === 'origin') {
      const childX = geometry.laneX.get(lane.key);
      const sourceX = mainLane ? geometry.laneX.get(mainLane.key) : null;
      if (childX !== undefined && sourceX !== undefined && childX !== sourceX) {
        const sourceY = timelineCurveSourceY(
          point.y,
          geometry.railEndY.get(mainLane.key) ?? Math.max(3, geometry.height - 3),
        );
        const path = timelineCurvePath({
          sourceX,
          targetX: childX,
          sourceY,
          targetY: point.y,
        });
        if (path) {
          paths.push(
            <path
              key={`origin:${entry.laneKey}`}
              className="timeline-graph-origin"
              d={path}
              stroke={lane.color}
              style={{ opacity: focusOpacity(lane.key) }}
            />,
          );
        }
      }
    } else if (entry.kind === 'integration' && entry.sourceLaneKey) {
      const sourceLane = laneByKey.get(entry.sourceLaneKey);
      const targetX = geometry.laneX.get(entry.laneKey);
      const sourceX = geometry.laneX.get(entry.sourceLaneKey);
      if (sourceLane && sourceX !== undefined && targetX !== undefined && sourceX !== targetX) {
        const sourceY = timelineCurveSourceY(
          point.y,
          geometry.railEndY.get(entry.sourceLaneKey) ?? Math.max(3, geometry.height - 3),
        );
        const path = timelineCurvePath({
          sourceX,
          targetX,
          sourceY,
          targetY: point.y,
        });
        if (path) {
          paths.push(
            <path
              key={`integration:${timelineEntryKey(entry)}`}
              className="timeline-graph-integration"
              d={path}
              stroke={sourceLane.color}
              style={{ opacity: focusOpacity(sourceLane.key) }}
            />,
          );
        }
      }
    }

    const connectorEnd = geometry.connectorEndX.get(timelineEntryKey(entry));
    if (!Number.isFinite(connectorEnd) || connectorEnd <= point.x) continue;
    paths.push(
      <path
        key={`connector:${timelineEntryKey(entry)}`}
        className={`timeline-graph-connector${entry.entryKind === 'origin-continuation' ? ' timeline-graph-continuation' : ''}`}
        d={`M ${point.x} ${point.y} H ${connectorEnd}`}
        style={{
          '--timeline-connector-color': focusedLaneKey === lane.key
            ? lane.color
            : 'var(--timeline-connector)',
          opacity: focusedLaneKey
            ? (focusedLaneKey === entry.laneKey ? 0.9 : 0.55)
            : 0.75,
        }}
      />,
    );
  }

  return (
    <svg
      className="timeline-graph-svg"
      aria-hidden="true"
      viewBox={`0 0 ${geometry.railWidth} ${Math.max(1, geometry.height)}`}
      preserveAspectRatio="none"
    >
      {paths}
    </svg>
  );
}

function TimelineHistory({ entries, lanes, focusedLaneKey, onFocusLane }) {
  const historyRef = useRef(null);
  const rowRefs = useRef(new Map());
  const [geometry, setGeometry] = useState(null);

  useEffect(() => {
    const history = historyRef.current;
    if (!history) return undefined;

    const measure = () => {
      const rootRect = history.getBoundingClientRect();
      const railWidth = timelineRailWidth(lanes.length, history.clientWidth);
      const points = new Map();
      const connectorEndX = new Map();
      for (const entry of entries) {
        const row = rowRefs.current.get(timelineEntryKey(entry));
        if (!row) continue;
        const article = row.querySelector('article');
        if (!article) continue;
        const articleRect = article.getBoundingClientRect();
        points.set(timelineEntryKey(entry), {
          x: timelineLaneX(
            lanes.find((lane) => lane.key === entry.laneKey) || lanes[0],
            lanes.length,
            railWidth,
          ),
          y: articleRect.top - rootRect.top + articleRect.height / 2,
        });
        connectorEndX.set(
          timelineEntryKey(entry),
          articleRect.left - rootRect.left,
        );
      }
      const railEndY = new Map(lanes.map((lane) => {
        const originEntry = entries.find((entry) => (
          entry.laneKey === lane.key
          && (entry.entryKind === 'origin' || entry.entryKind === 'origin-continuation')
        ));
        const originPoint = originEntry ? points.get(timelineEntryKey(originEntry)) : null;
        return [lane.key, timelineRailEndY({
          laneRole: lane.role,
          originY: originPoint?.y,
          historyHeight: Math.max(history.scrollHeight, history.clientHeight),
        })];
      }));
      setGeometry({
        railWidth,
        height: Math.max(history.scrollHeight, history.clientHeight),
        laneX: new Map(lanes.map((lane) => [lane.key, timelineLaneX(lane, lanes.length, railWidth)])),
        railEndY,
        points,
        connectorEndX,
      });
    };

    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(measure)
      : setTimeout(measure, 0);
    const cancelFrame = () => {
      if (typeof cancelAnimationFrame === 'function' && typeof frame === 'number') {
        cancelAnimationFrame(frame);
      } else {
        clearTimeout(frame);
      }
    };
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure)
      : null;
    resizeObserver?.observe(history);
    for (const row of rowRefs.current.values()) resizeObserver?.observe(row);
    window.addEventListener('resize', measure);

    return () => {
      cancelFrame();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [entries, lanes]);

  const historyStyle = {
    '--timeline-rail-width': `${geometry?.railWidth ?? timelineRailWidth(lanes.length, 800)}px`,
  };

  return (
    <div
      ref={historyRef}
      className={`timeline-history${focusedLaneKey ? ' has-focused-lane' : ''}`}
      style={historyStyle}
      data-lane-count={lanes.length}
    >
      <div className="timeline-graph" aria-hidden="true">
        <TimelineGraph
          geometry={geometry}
          entries={entries}
          lanes={lanes}
          focusedLaneKey={focusedLaneKey}
        />
      </div>
      {geometry && (
        <div className="timeline-graph-targets">
          {entries.map((entry) => {
            const point = geometry.points.get(timelineEntryKey(entry));
            const lane = lanes.find((candidate) => candidate.key === entry.laneKey) || lanes[0];
            if (!point || !lane) return null;
            const isFocused = focusedLaneKey === lane.key;
            return (
              <button
                type="button"
                className={`timeline-rail-node${entry.entryKind === 'origin' || entry.entryKind === 'origin-continuation' ? ' is-origin' : ''}`}
                key={`target:${timelineEntryKey(entry)}`}
                style={{
                  '--timeline-node-x': `${point.x}px`,
                  '--timeline-node-y': `${point.y}px`,
                  '--timeline-lane-color': lane.color,
                }}
                aria-label={`突出显示${lane.label}工作线`}
                aria-pressed={isFocused}
                onClick={() => onFocusLane(lane.key)}
              >
                <span aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      <ol className="project-timeline" aria-label="最新在上的项目运行节点">
        {entries.map((entry, index) => {
          const lane = lanes.find((candidate) => candidate.key === entry.laneKey) || lanes[0];
          const isFocused = focusedLaneKey === lane.key;
          const isDimmed = Boolean(focusedLaneKey && !isFocused);
          const rowClass = [
            'timeline-node',
            entry.entryKind === 'origin' || entry.entryKind === 'origin-continuation'
              ? 'timeline-node-origin'
              : `timeline-node-${entry.kind}`,
            entry.entryKind === 'origin-continuation' ? 'is-origin-continuation' : '',
            isFocused ? 'is-lane-focused' : '',
            isDimmed ? 'is-lane-dimmed' : '',
          ].filter(Boolean).join(' ');
          const rowStyle = {
            '--timeline-index': Math.min(index, 9),
            '--timeline-lane-color': lane.color,
          };
          const setRowRef = (node) => {
            const key = timelineEntryKey(entry);
            if (node) rowRefs.current.set(key, node);
            else rowRefs.current.delete(key);
          };

          if (entry.entryKind === 'origin' || entry.entryKind === 'origin-continuation') {
            return (
              <TimelineOriginNode
                key={timelineEntryKey(entry)}
                ref={setRowRef}
                entry={entry}
                lane={lane}
                className={rowClass}
                style={rowStyle}
                focusedLaneKey={focusedLaneKey}
                onFocusLane={onFocusLane}
              />
            );
          }

          return (
            <TimelineNode
              key={timelineEntryKey(entry)}
              ref={setRowRef}
              item={entry}
              index={index}
              lane={lane}
              className={rowClass}
              style={rowStyle}
              focusedLaneKey={focusedLaneKey}
              onFocusLane={onFocusLane}
            />
          );
        })}
      </ol>
    </div>
  );
}

const TimelineOriginNode = React.forwardRef(function TimelineOriginNode({
  entry,
  lane,
  className,
  style,
  focusedLaneKey,
  onFocusLane,
}, ref) {
  const origin = entry.origin ?? {};
  const baseCommit = origin.baseCommit ? origin.baseCommit.slice(0, 7) : null;
  const isContinuation = entry.entryKind === 'origin-continuation';
  const onCardClick = (event) => {
    if (event.target?.closest?.('button, a, summary, input, select, textarea')) return;
    onFocusLane(lane.key);
  };

  return (
    <li ref={ref} className={className} style={style} data-lane-key={lane.key}>
      <article className="timeline-origin-card" onClick={onCardClick}>
        <header className="timeline-origin-header">
          <button
            type="button"
            className="timeline-lane-focus"
            style={{ '--timeline-lane-color': lane.color }}
            aria-pressed={focusedLaneKey === lane.key}
            aria-label={`突出显示${lane.label}工作线`}
            onClick={(event) => {
              event.stopPropagation();
              onFocusLane(lane.key);
            }}
          >
            <span className="timeline-lane-swatch" aria-hidden="true" />
            <span>{lane.label}</span>
          </button>
          <span className="timeline-origin-label">{isContinuation ? '来源较早记录' : '工作副本来源'}</span>
          <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
        </header>
        {isContinuation ? (
          <>
            <p><strong>来源记录在当前页之外</strong>，继续加载更早记录可查看完整上下文。</p>
            <small>这条工作线保持在原位；当前页面未把未加载记录算作已展示。</small>
          </>
        ) : (
          <>
            <p><strong>开发空间已创建</strong>，从这里开始沿独立工作线记录。</p>
            <small>
              创建时采用的基线 {baseCommit ? <code>{baseCommit}</code> : '未记录'}
              {origin.branch ? <> · 工作线 <code>{origin.branch}</code></> : ''}
            </small>
          </>
        )}
      </article>
    </li>
  );
});

const TimelineNode = React.forwardRef(function TimelineNode({
  item,
  index,
  lane,
  className,
  style,
  focusedLaneKey,
  onFocusLane,
}, ref) {
  const kind = TIMELINE_KINDS[item.kind] ?? { code: 'EVENT', label: item.typeLabel || '运行节点' };
  const detailGroups = [
    ['已完成', item.completedItems],
    ['待继续', item.pendingItems],
    ['关键决定', item.decisions],
    ['风险', item.risks],
  ].filter(([, values]) => Array.isArray(values) && values.length > 0);
  const relayInfo = getRelayStateInfo(item);
  const isRelayOrHandoff = item.kind === 'relay' || item.kind === 'handoff';
  const hasCollapsibleContext = isRelayOrHandoff || item.kind === 'init';
  const hasCounts = isRelayOrHandoff && (
    (item.completedItems?.length > 0) ||
    (item.pendingItems?.length > 0) ||
    (item.decisions?.length > 0) ||
    (item.risks?.length > 0)
  );
  const hasContextDetails = Boolean(
    (item.currentState && item.currentState !== item.summary) ||
    detailGroups.length > 0
  );

  const onCardClick = (event) => {
    if (event.target?.closest?.('button, a, summary, input, select, textarea')) return;
    onFocusLane(lane.key);
  };

  return (
    <li
      ref={ref}
      className={className}
      style={style}
      data-lane-key={lane.key}
      data-lane-role={lane.role}
    >
      <article className="timeline-bubble" onClick={onCardClick}>
        <header className="timeline-node-header">
          <div className="timeline-kind-wrap">
            <button
              type="button"
              className="timeline-lane-focus"
              style={{ '--timeline-lane-color': lane.color }}
              aria-pressed={focusedLaneKey === lane.key}
              aria-label={`突出显示${lane.label}工作线`}
              onClick={(event) => {
                event.stopPropagation();
                onFocusLane(lane.key);
              }}
            >
              <span className="timeline-lane-swatch" aria-hidden="true" />
              <span>{lane.label}</span>
            </button>
            <span className="timeline-kind-code">{kind.code}</span>
            <strong>{kind.label}</strong>
          </div>
          <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
        </header>

        <div className="timeline-context-row">
          {item.kind !== 'integration' && <span className="timeline-agent">AI · {item.agent || '未记录'}</span>}
          {item.kind === 'integration' ? (
            <>
              <span className="integration-receipt-chip">已确认接入</span>
              {item.sourceBranch && <span className="git-chip git-branch">来源 {item.sourceBranch}</span>}
              {item.integratedCommit && <span className="git-chip git-commit">主项目 {item.integratedCommit.slice(0, 7)}</span>}
            </>
          ) : item.git ? (
            item.git.coherence === 'coherent' ? (
              <>
                {item.git.branch && <span className="git-chip git-branch">{item.git.branch}</span>}
                {item.git.shortHead && <span className="git-chip git-commit">{item.git.shortHead}</span>}
                {!item.git.branch && !item.git.shortHead && (
                  <span className="git-unrecorded">Git 未采集</span>
                )}
              </>
            ) : (
              (item.git.branch || item.git.shortHead) ? (
                <span className="git-chip git-unverified" title="代码状态未确认">
                  未确认 {item.git.branch || ''} {item.git.shortHead || ''}
                </span>
              ) : (
                <span className="git-unrecorded">Git 未采集</span>
              )
            )
          ) : (
            <span className="git-unrecorded">{item.kind === 'progress' || item.kind === 'relay' ? 'Git 未采集' : '当时分支未记录'}</span>
          )}
          {relayInfo && (
            <span className={`relay-status-chip relay-status-${relayInfo.statusTheme}`}>
              {relayInfo.label}{relayInfo.acceptedAt ? ` · ${formatTime(relayInfo.acceptedAt)}` : ''}
            </span>
          )}
          {item.kind === 'handoff' && (
            <span className="handoff-status-chip">阶段已交接</span>
          )}
        </div>

        <h4>{item.summary || item.note || kind.label}</h4>

        {hasCounts && (
          <div className="timeline-counts-row">
            {item.completedItems?.length > 0 && (
              <span className="timeline-count-badge">已完成 {item.completedItems.length}</span>
            )}
            {item.pendingItems?.length > 0 && (
              <span className="timeline-count-badge">待继续 {item.pendingItems.length}</span>
            )}
            {item.decisions?.length > 0 && (
              <span className="timeline-count-badge">决定 {item.decisions.length}</span>
            )}
            {item.risks?.length > 0 && (
              <span className="timeline-count-badge">风险 {item.risks.length}</span>
            )}
          </div>
        )}

        {item.nextSessionFocus && (
          <div className="timeline-next-focus"><span>下一步</span>{item.nextSessionFocus}</div>
        )}

        {hasCollapsibleContext ? (
          hasContextDetails && (
            <details className="timeline-details-accordion">
              <summary>{item.kind === 'relay'
                ? '查看接力上下文'
                : item.kind === 'handoff'
                  ? '查看交接详情'
                  : '查看接入状态'}</summary>
              <div className="timeline-details-content">
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
              </div>
            </details>
          )
        ) : (
          <>
            {item.currentState && item.currentState !== item.summary && (
              <p className="timeline-current-state"><span>当前状态</span>{item.currentState}</p>
            )}

            {item.details && item.details.length > 0 && (
              <div className="timeline-progress-details-wrap">
                <ul className="timeline-progress-details">
                  {item.details.slice(0, 3).map((detail, dIdx) => (
                    <li key={`detail-${dIdx}`}>{detail}</li>
                  ))}
                </ul>
                {item.details.length > 3 && (
                  <details className="timeline-details-expand">
                    <summary>查看更多详情（共 {item.details.length} 条）</summary>
                    <ul className="timeline-progress-details">
                      {item.details.slice(3).map((detail, dIdx) => (
                        <li key={`detail-more-${dIdx}`}>{detail}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
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
          </>
        )}

        {item.bodyMarkdown && (
          <details className="timeline-full-record">
            <summary>查看完整交接记录</summary>
            <pre>{item.bodyMarkdown}</pre>
          </details>
        )}

        {item.kind === 'progress' && item.note && (item.isLegacyNote || (item.note !== item.summary && (!item.details || item.details.length === 0))) && (
          <details className="timeline-full-record">
            <summary>查看完整进展</summary>
            <pre>{item.note}</pre>
          </details>
        )}
      </article>
    </li>
  );
});

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
