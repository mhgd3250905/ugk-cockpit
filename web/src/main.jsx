import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, buttonVariants } from '@appica/ui-react/button';
import { Badge } from '@appica/ui-react/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from '@appica/ui-react/dialog';
import { Field, FieldDescription, FieldLabel } from '@appica/ui-react/field';
import { Input } from '@appica/ui-react/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@appica/ui-react/select';
import { Textarea } from '@appica/ui-react/textarea';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from '@appica/ui-react/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@appica/ui-react/avatar';
import { Skeleton } from '@appica/ui-react/skeleton';
import { Spinner } from '@appica/ui-react/spinner';
import { createApiClient } from './api.js';
import { SUBMIT_MESSAGE, deliveryStatusLabel, noteStatusLabel } from './delivery-view.mjs';
import { SubmitNotesInbox, renderSafeTextWithLinks } from './submit-notes-view.mjs';
import {
  timelineCurvePath,
  timelineCurveSourceY,
  timelineRailEndY,
} from './timeline-geometry.mjs';
import {
  extractDominantColorFromImage,
  getProjectCardAvatarColorStyle,
  projectAvatarUrl,
} from './avatar-color.mjs';
import { copyNoteText } from './copy-note-text.mjs';
import { completeAssignmentCopy } from './assignment-copy-flow.mjs';
import {
  classifyWorkspaceActionError,
  createWorkspaceActionRecord,
  getWorkspaceActionStorage,
  markWorkspaceActionPending,
  markWorkspaceActionUnknown,
  readWorkspaceActionRecordsWithStatus,
  removeWorkspaceActionRecord,
  upsertWorkspaceActionRecord,
  WORKSPACE_ACTION_RECOVERY_STORAGE_KEY,
} from './workspace-action-recovery.mjs';
import { WorkbenchShell } from './workbench-shell.jsx';
import { WorkContext } from './work-context.jsx';
import { ManualRecordAction } from './manual-record-action.jsx';
import './styles.css';
import './workbench.css';

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

const STAGE_OPTIONS = [
  { value: 'development', label: '开发中' },
  { value: 'maintenance', label: '已经上线，只做日常维护' },
  { value: 'paused', label: '暂时放下' },
];

const AGENT_OPTIONS = [
  { value: 'Codex', label: 'Codex' },
  { value: 'ZCode', label: 'ZCode' },
  { value: 'Antigravity', label: 'Antigravity' },
];

const TIMELINE_KINDS = {
  init: { code: 'INIT', label: '接入项目' },
  progress: { code: 'PROGRESS', label: '工作进展' },
  relay: { code: 'RELAY', label: '聊天接力' },
  handoff: { code: 'HANDOFF', label: '阶段交接' },
  integration: { code: 'INTEGRATED', label: '接入主项目' },
  submit_note: { code: 'NOTE', label: '工作说明' },
  work_line_closed: { code: 'CLOSED', label: '用户手动结束' },
  work_line_reopened: { code: 'REOPENED', label: '用户重新打开' },
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

function timelineDetailText(detail) {
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'number') return String(detail);
  if (!detail || typeof detail !== 'object') return '未提供详情';
  const transferLabels = {
    'conversation.transfer.issue': '用户授权转交，等待新聊天接手',
    'conversation.transfer.consume': '新聊天已接手',
    'conversation.transfer.cancel': '取消转交并恢复原聊天',
  };
  const label = transferLabels[detail.nodeType];
  if (label) {
    const actor = detail.actor;
    const identity = actor?.type === 'user' ? '项目所有者' : actor?.type === 'ai'
      && typeof actor.platform === 'string' && typeof actor.conversationId === 'string'
      ? `${actor.platform} / ${actor.conversationId}` : '身份未记录';
    return `${label} · ${identity}`;
  }
  return typeof detail.summary === 'string' ? detail.summary : '结构化工作记录（未提供文字摘要）';
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
const workspaceActionStorage = getWorkspaceActionStorage();
const initialWorkspaceActionState = readWorkspaceActionRecordsWithStatus(workspaceActionStorage);

const AVATAR_COLOR_CACHE_LIMIT = 128;
const avatarColorCache = new Map();
const avatarColorPending = new Map();

function rememberAvatarColor(avatarUrl, color) {
  if (avatarColorCache.size >= AVATAR_COLOR_CACHE_LIMIT && !avatarColorCache.has(avatarUrl)) {
    const oldestUrl = avatarColorCache.keys().next().value;
    if (oldestUrl) avatarColorCache.delete(oldestUrl);
  }
  avatarColorCache.set(avatarUrl, color);
}

function loadAvatarDominantColor(avatarUrl) {
  if (!avatarUrl) return Promise.resolve(null);
  if (avatarColorCache.has(avatarUrl)) return Promise.resolve(avatarColorCache.get(avatarUrl));
  if (avatarColorPending.has(avatarUrl)) return avatarColorPending.get(avatarUrl);

  const ImageConstructor = globalThis.Image;
  if (typeof ImageConstructor !== 'function') {
    rememberAvatarColor(avatarUrl, null);
    return Promise.resolve(null);
  }

  const pending = new Promise((resolve) => {
    const image = new ImageConstructor();
    let settled = false;
    const finish = (color) => {
      if (settled) return;
      settled = true;
      rememberAvatarColor(avatarUrl, color);
      avatarColorPending.delete(avatarUrl);
      resolve(color);
    };

    image.onload = () => {
      // Keep the canvas work off the image event's critical path while still
      // resolving quickly for a card that has just entered the viewport.
      const sample = () => {
        try {
          finish(extractDominantColorFromImage(image));
        } catch {
          finish(null);
        }
      };
      try {
        if (typeof globalThis.requestIdleCallback === 'function') {
          globalThis.requestIdleCallback(sample, { timeout: 200 });
        } else {
          globalThis.setTimeout(sample, 0);
        }
      } catch {
        finish(null);
      }
    };
    image.onerror = () => finish(null);
    try {
      image.decoding = 'async';
      image.src = avatarUrl;
    } catch {
      finish(null);
    }
  });

  avatarColorPending.set(avatarUrl, pending);
  return pending;
}

function useProjectAvatarColor(project) {
  const avatarUrl = projectAvatarUrl(project);
  const [color, setColor] = useState(() => (
    avatarUrl && avatarColorCache.has(avatarUrl) ? avatarColorCache.get(avatarUrl) : null
  ));

  useEffect(() => {
    let active = true;
    if (!avatarUrl) {
      setColor(null);
      return () => { active = false; };
    }

    if (avatarColorCache.has(avatarUrl)) {
      setColor(avatarColorCache.get(avatarUrl));
      return () => { active = false; };
    }

    // Clear a previous avatar's tint immediately; a slow new image must not
    // leave the old project's color visible on this card.
    setColor(null);
    loadAvatarDominantColor(avatarUrl).then((nextColor) => {
      if (active) setColor(nextColor);
    });

    return () => { active = false; };
  }, [avatarUrl]);

  return color;
}

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

function ProjectAvatar({ project, avatarUrl, size, className }) {
  return (
    <Avatar size={size} shape="rounded" className={`project-avatar ${className || ''}`}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback>{project?.name ? project.name.slice(0, 2) : 'UGK'}</AvatarFallback>
    </Avatar>
  );
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
    tone: 'error',
    message: error?.message ?? message,
    impact: error?.impact ?? impact,
    required_action: error?.required_action ?? requiredAction,
    actionLabel,
    retry,
  };
}

// Guard used by all Appica dialogs: block Esc/outside-press dismissal while a
// request is in flight so the user cannot lose a submitting form.
function createDialogCloseGuard(busy, onClose) {
  return (open, eventDetails) => {
    if (open) return;
    if (busy) {
      eventDetails?.cancel?.();
      return;
    }
    onClose();
  };
}

function workspaceActionPath(record) {
  return `/api/v1/projects/${encodeURIComponent(record.projectId)}/spaces/${encodeURIComponent(record.spaceId)}/${record.kind}`;
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
  const [sessionDiagnostics, setSessionDiagnostics] = useState(null);
  const [sessionDiagnosticsLoading, setSessionDiagnosticsLoading] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [spaceAction, setSpaceAction] = useState(null);
  const [pendingWorkspaceActions, setPendingWorkspaceActions] = useState(
    initialWorkspaceActionState.records,
  );
  const [workspaceActionStorageError, setWorkspaceActionStorageError] = useState(
    initialWorkspaceActionState.error,
  );
  const [themeMode, setThemeMode] = useTheme();
  const detailRequestRef = useRef(0);
  const diagnosticsRequestRef = useRef(0);
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

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== null && event.key !== WORKSPACE_ACTION_RECOVERY_STORAGE_KEY) return;
      const next = readWorkspaceActionRecordsWithStatus(workspaceActionStorage);
      setPendingWorkspaceActions(next.records);
      setWorkspaceActionStorageError(next.error);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

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
      diagnosticsRequestRef.current += 1;
      setProjectDetail(null);
      setSessionDiagnostics(null);
      setSessionDiagnosticsLoading(false);
      return;
    }

    if (route.invalid) {
      const requestId = ++detailRequestRef.current;
      diagnosticsRequestRef.current += 1;
      setSessionDiagnostics(null);
      setSessionDiagnosticsLoading(false);
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
    diagnosticsRequestRef.current += 1;
    setSessionDiagnostics(null);
    setSessionDiagnosticsLoading(false);
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

  const dashboardPollSeqRef = useRef(0);
  useEffect(() => {
    refresh();
    const timer = setInterval(async () => {
      // 序号守卫：慢响应晚于新响应到达时不得用旧数据覆盖新数据。
      const sequence = ++dashboardPollSeqRef.current;
      try {
        const data = await api('/api/v1/dashboard');
        if (sequence !== dashboardPollSeqRef.current) return;
        setDashboard(data);
        setIsStale(false);
      } catch {
        if (sequence === dashboardPollSeqRef.current) setIsStale(true);
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
          tone: 'success',
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
        tone: 'success',
        message: '接手消息已复制。',
        required_action: `把它发送给 ${handoffAgent}；成功接入后页面会显示工作会话已经接入。`,
        actionLabel: '知道了',
        retry: () => setNotice(null),
      });
    } catch {
      setNotice({
        tone: 'error',
        message: '无法自动写入剪贴板。',
        impact: '接入指令仍完整显示，项目代码和接手任务不受影响。',
        required_action: '请直接选中文本框内的完整接入指令并按 Ctrl+C / Cmd+C 复制。',
        actionLabel: '重试复制',
        retry: () => copyDispatchMessage(),
      });
    }
  }

  async function saveProjectEdit(projectId, { name, avatarPath }) {
    const commandId = crypto.randomUUID();
    const result = await api(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({
        commandId,
        name,
        avatarPath,
      }),
    });

    setDashboard((previous) => {
      if (!previous || !previous.projects) return previous;
      return {
        ...previous,
        projects: previous.projects.map((p) => (
          p.id === projectId
            ? { ...p, name: result.name, avatarPath: result.avatarPath }
            : p
        )),
      };
    });

    setProjectDetail((previous) => {
      if (!previous) return previous;
      const seed = previous.seed && previous.seed.id === projectId
        ? { ...previous.seed, name: result.name, avatarPath: result.avatarPath }
        : previous.seed;
      const data = previous.data && previous.data.project && previous.data.project.id === projectId
        ? {
            ...previous.data,
            project: {
              ...previous.data.project,
              name: result.name,
              avatarPath: result.avatarPath,
            },
          }
        : previous.data;
      return {
        ...previous,
        seed,
        data,
      };
    });

    setEditingProject(null);
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

  async function refreshManualRecords() {
    await Promise.all([refresh(), refreshOpenProjectDetail()]);
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
    let result;
    try {
      result = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/assignments`, {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          agent: 'Codex',
          mode: 'init',
          task: `在${space.name || '开发空间'}中继续功能开发`,
          spaceId: space.spaceId,
        }),
      });
    } catch (error) {
      setBusy(false);
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
      return;
    }
    if (!isCurrentDetailRequest(requestId, projectId)) { setBusy(false); return; }
    // Clipboard write and detail refresh are best-effort follow-ups handled by
    // completeAssignmentCopy: busy stays on until they settle so a double
    // click cannot re-create the assignment, and a failed refresh keeps the
    // "generated and copied" fact with a read-only retry.
    await completeAssignmentCopy({
      copyText: () => copyNoteText(result.message),
      refreshDetail: refreshOpenProjectDetail,
      notify: setNotice,
      isCurrent: () => isCurrentDetailRequest(requestId, projectId),
    });
    setBusy(false);
  }

  function setWorkspaceActionRecords(records) {
    setPendingWorkspaceActions(Array.isArray(records) ? records : []);
    setWorkspaceActionStorageError(null);
  }

  function setWorkspaceActionState({ records, error = null }) {
    setPendingWorkspaceActions(Array.isArray(records) ? records : []);
    setWorkspaceActionStorageError(error);
  }

  function readWorkspaceActionState() {
    const next = readWorkspaceActionRecordsWithStatus(workspaceActionStorage);
    setWorkspaceActionState(next);
    return next;
  }

  function isExactWorkspaceActionRecord(left, right) {
    return Boolean(left && right)
      && left.id === right.id
      && left.commandId === right.commandId
      && JSON.stringify(left.request) === JSON.stringify(right.request);
  }

  function findWorkspaceActionForSpace(records, projectId, spaceId) {
    return (Array.isArray(records) ? records : []).find((item) => (
      item.projectId === projectId && item.spaceId === spaceId
    )) ?? null;
  }

  function setWorkspaceActionNotice(requestId, projectId, actionNotice) {
    if (!isCurrentDetailRequest(requestId, projectId)) return;
    setProjectDetail((previous) => previous ? {
      ...previous,
      ...(previous.requestId === requestId && previous.seed.id === projectId ? { actionNotice } : {}),
    } : previous);
  }

  function workspaceActionName(record) {
    return record.kind === 'reuse' ? '重新开始' : '删除空间';
  }

  function workspaceActionFailureNotice(record, error, outcome, storageError = null) {
    const name = record.spaceName || '这个开发空间';
    if (outcome === 'unknown') {
      return {
        error: true,
        message: `${name}的${workspaceActionName(record)}结果未知。`,
        detail: `服务没有确认这次操作是否完成；原请求已保留。请在开发空间区域点击“恢复并核对”，系统会继续使用同一个请求号和参数。${storageError ? ' 恢复材料暂时无法更新，请先恢复本站点存储后再试。' : ''}`,
      };
    }
    return {
      error: true,
      message: `${name}没有${workspaceActionName(record)}。`,
      detail: `${error?.required_action || error?.message || '服务已明确拒绝这次请求，请刷新当前项目后再试。'}${storageError ? ' 恢复材料暂时未能清理，仍会保留同一请求供核对。' : ''}`,
    };
  }

  function persistPendingWorkspaceAction(record) {
    const records = upsertWorkspaceActionRecord(record, workspaceActionStorage);
    setWorkspaceActionRecords(records);
    return records;
  }

  function persistWorkspaceActionFailure(record, error, outcome) {
    let storageError = null;
    let records;
    try {
      records = outcome === 'unknown'
        ? markWorkspaceActionUnknown(record, error, workspaceActionStorage)
        : removeWorkspaceActionRecord(record, workspaceActionStorage);
    } catch (persistError) {
      storageError = persistError;
      const current = readWorkspaceActionState();
      records = current.records;
      if (persistError?.code === 'WORKSPACE_ACTION_RECOVERY_CONFLICT') {
        storageError = null;
      } else if (current.error) {
        storageError = current.error;
      }
    }
    if (storageError) {
      setPendingWorkspaceActions(Array.isArray(records) ? records : []);
      setWorkspaceActionStorageError(storageError);
    } else {
      setWorkspaceActionRecords(records);
    }
    return storageError;
  }

  async function submitPersistedWorkspaceAction(record, { requestId, successNotice }) {
    try {
      await api(workspaceActionPath(record), {
        method: 'POST',
        body: JSON.stringify(record.request),
      });
    } catch (error) {
      const outcome = classifyWorkspaceActionError(error);
      const storageError = persistWorkspaceActionFailure(record, error, outcome);
      if (isCurrentDetailRequest(requestId, record.projectId)) {
        setSpaceAction(null);
        setWorkspaceActionNotice(
          requestId,
          record.projectId,
          workspaceActionFailureNotice(record, error, outcome, storageError),
        );
      }
      return { ok: false, outcome };
    }

    let storageError = null;
    try {
      setWorkspaceActionRecords(removeWorkspaceActionRecord(record, workspaceActionStorage));
    } catch (error) {
      const current = readWorkspaceActionState();
      storageError = current.error || error;
    }

    if (isCurrentDetailRequest(requestId, record.projectId)) {
      setSpaceAction(null);
      try {
        await refreshOpenProjectDetail({
          ...successNotice,
          detail: `${successNotice.detail}${storageError ? ' 操作已确认，但浏览器暂时无法清理恢复材料；页面会继续显示同一请求供再次核对。' : ''}`,
        });
      } catch {
        setWorkspaceActionNotice(requestId, record.projectId, {
          error: false,
          message: successNotice.message,
          detail: `${successNotice.detail} 操作已经确认，但项目详情暂时没有刷新。${storageError ? '恢复材料仍保留，请先恢复本站点存储后再重新核对。' : '请稍后重新读取详情。'}`,
        });
      }
    }
    return { ok: true };
  }

  async function confirmSpaceAction() {
    const action = spaceAction;
    const current = projectDetailRef.current;
    const project = current?.data?.project;
    const projectId = project?.id;
    const requestId = current?.requestId;
    if (!action || !projectId || !isCurrentDetailRequest(requestId, projectId)) return;

    setBusy(true);
    let record = null;
    try {
      // A modal can stay open while another tab completes or starts an
      // operation. Read the durable store before refreshing or minting any
      // new command so this confirmation cannot race a newer request.
      const stored = readWorkspaceActionState();
      if (stored.error) throw stored.error;
      const existing = findWorkspaceActionForSpace(
        stored.records,
        projectId,
        action.space.spaceId,
      );
      if (existing) {
        setSpaceAction(null);
        setWorkspaceActionNotice(requestId, projectId, {
          error: true,
          message: `${action.space.name || '这个开发空间'}已有待核对的开发空间操作。`,
          detail: '没有发送新的开发空间操作。请在开发空间区域点击“恢复并核对”，系统会继续使用原请求号和参数。',
        });
        return;
      }

      // The command id is allocated once for the whole user-confirmed action.
      // Reuse still refreshes the main observation first, then freezes the
      // exact body that will be sent before the workspace mutation starts.
      const commandId = crypto.randomUUID();
      const request = action.kind === 'reuse'
        ? await (async () => {
            const refreshed = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/refresh`, {
              method: 'POST',
              body: JSON.stringify({ commandId: crypto.randomUUID() }),
            });
            return {
              commandId,
              expectedRevision: action.space.revision,
              expectedBaseHead: refreshed.git.head,
            };
          })()
        : {
            commandId,
            expectedRevision: action.space.revision,
          };

      record = createWorkspaceActionRecord({
        kind: action.kind,
        projectId,
        spaceId: action.space.spaceId,
        spaceName: action.space.name,
        request,
      });
      // Persist before the first workspace POST. A page or service restart
      // after this point can always recover the exact idempotent request.
      persistPendingWorkspaceAction(record);
      await submitPersistedWorkspaceAction(record, {
        requestId,
        successNotice: {
          message: action.kind === 'reuse'
            ? `${action.space.name} 已准备好新的开发工作。`
            : `${action.space.name} 已从本机移除。`,
          detail: action.kind === 'reuse'
            ? '新的工作从主项目当前本地提交开始；之前的工作线仍保留，方便需要时找回。'
            : '本地工作副本已释放；此前的工作线和项目记录仍保留，方便需要时找回。',
        },
      });
    } catch (error) {
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      setSpaceAction(null);
      const conflict = error?.code === 'WORKSPACE_ACTION_RECOVERY_CONFLICT';
      if (!conflict && error?.code?.startsWith('WORKSPACE_ACTION_RECOVERY_')) {
        const currentState = readWorkspaceActionState();
        if (!currentState.error) setWorkspaceActionStorageError(error);
      }
      setWorkspaceActionNotice(requestId, projectId, {
        error: true,
        message: conflict
          ? `${action.space.name || '这个开发空间'}已有待核对的开发空间操作。`
          : record
          ? '无法保存开发空间操作的恢复材料。'
          : '还没有确认开发空间操作。',
        detail: conflict
          ? '没有发送新的开发空间操作。请在开发空间区域点击“恢复并核对”，系统会继续使用原请求号和参数。'
          : record
          ? '没有发送删除或重新开始请求；原有代码和工作记录没有被修改。请确认浏览器允许保存本站点数据后重试。'
          : (error?.required_action || error?.message || '主项目状态没有刷新完成；没有发送开发空间操作，请刷新后重试。'),
      });
    } finally {
      setBusy(false);
    }
  }

  async function recoverWorkspaceAction(record) {
    const current = projectDetailRef.current;
    const projectId = current?.data?.project?.id;
    const requestId = current?.requestId;
    if (!record || !projectId || record.projectId !== projectId || !isCurrentDetailRequest(requestId, projectId)) return;
    setBusy(true);
    try {
      // Use the current stored record. A stale button from another tab must
      // never revive or overwrite a different command for this space.
      const stored = readWorkspaceActionState();
      if (stored.error) throw stored.error;
      const exact = stored.records.find((item) => isExactWorkspaceActionRecord(item, record));
      if (!exact) {
        setWorkspaceActionNotice(requestId, projectId, {
          error: true,
          message: `${record.spaceName || '这个开发空间'}的恢复材料已在其他页面发生变化。`,
          detail: '没有发送新的开发空间操作。请刷新当前项目后，以开发空间区域显示的最新恢复材料为准。',
        });
        return;
      }
      const marked = markWorkspaceActionPending(exact, workspaceActionStorage);
      if (!marked.some((item) => isExactWorkspaceActionRecord(item, exact))) {
        setWorkspaceActionRecords(marked);
        setWorkspaceActionNotice(requestId, projectId, {
          error: true,
          message: `${exact.spaceName || '这个开发空间'}的恢复材料已在其他页面处理。`,
          detail: '没有发送新的开发空间操作。请刷新当前项目后，以开发空间区域显示的最新状态为准。',
        });
        return;
      }
      setWorkspaceActionRecords(marked);
      await submitPersistedWorkspaceAction(exact, {
        requestId,
        successNotice: {
          message: `${exact.spaceName || '开发空间'} 的${workspaceActionName(exact)}已确认。`,
          detail: '系统使用了原来的请求号和参数完成核对；页面会重新读取当前开发空间状态。',
        },
      });
    } catch (error) {
      if (!isCurrentDetailRequest(requestId, projectId)) return;
      const conflict = error?.code === 'WORKSPACE_ACTION_RECOVERY_CONFLICT';
      if (!conflict && error?.code?.startsWith('WORKSPACE_ACTION_RECOVERY_')) {
        const currentState = readWorkspaceActionState();
        if (!currentState.error) setWorkspaceActionStorageError(error);
      }
      setWorkspaceActionNotice(requestId, projectId, {
        error: true,
        message: conflict
          ? `${record.spaceName || '这个开发空间'}已有更新的开发空间操作。`
          : '还没有重新核对开发空间操作。',
        detail: conflict
          ? '没有发送新的开发空间操作；页面会保留最新请求，请以开发空间区域显示的恢复材料为准。'
          : error?.message || '没有发送新的开发空间操作；原恢复材料仍保留，请稍后重试。',
      });
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

  async function loadSessionDiagnostics() {
    const projectId = activeDetailProjectId;
    if (!projectId) return;
    const requestId = ++diagnosticsRequestRef.current;
    setSessionDiagnosticsLoading(true);
    setSessionDiagnostics((previous) => (
      previous?.projectId === projectId ? { ...previous, error: null } : null
    ));
    try {
      const data = await api(
        `/api/v1/projects/${encodeURIComponent(projectId)}/session-diagnostics?limit=30`,
      );
      if (
        diagnosticsRequestRef.current !== requestId
        || readAppRoute().kind !== 'detail'
        || readAppRoute().projectId !== projectId
      ) return;
      setSessionDiagnostics(data);
    } catch (error) {
      if (
        diagnosticsRequestRef.current !== requestId
        || readAppRoute().kind !== 'detail'
        || readAppRoute().projectId !== projectId
      ) return;
      setSessionDiagnostics({
        projectId,
        entries: [],
        error: createErrorNotice(error, {
          message: '近期会话诊断暂时无法读取。',
          impact: '项目代码和已有工作记录不受影响。',
          requiredAction: '请确认本机服务仍在运行，然后重试读取。',
        }),
      });
    } finally {
      if (diagnosticsRequestRef.current === requestId) setSessionDiagnosticsLoading(false);
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
    <WorkbenchShell
      projects={projects}
      activeProjectId={route.kind === 'detail' ? activeDetailProjectId : null}
      activeProjectName={projectDetail?.seed?.id === activeDetailProjectId ? (projectDetail.data?.project?.name || projectDetail.seed.name) : undefined}
      onOpenProject={openProjectDetail}
      onOverview={closeProjectDetail}
      onAddProject={() => chooseFolder()}
      busy={busy}
      themeControl={<ThemeSwitch mode={themeMode} onChange={setThemeMode} />}
      isStale={isStale}
      refreshedAt={dashboard?.refreshedAt}
      onRefresh={() => refresh()}
    >
      <main className="control-content">
        {notice && !selection && !handoffProject && <NoticeBanner notice={notice} busy={busy} />}
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
            onReuseSpace={(space) => setSpaceAction({ kind: 'reuse', space })}
            onRemoveSpace={(space) => setSpaceAction({ kind: 'remove', space })}
            pendingWorkspaceActions={pendingWorkspaceActions}
            workspaceActionStorageError={workspaceActionStorageError}
            onRecoverWorkspaceAction={recoverWorkspaceAction}
            onCopyReviewPrompt={copyIntegrationPrompt}
            onNoteStatusChange={refreshOpenProjectDetail}
            onRecordsChanged={refreshManualRecords}
            onLoadDiagnostics={loadSessionDiagnostics}
            diagnostics={sessionDiagnostics?.projectId === activeDetailProjectId ? sessionDiagnostics : null}
            diagnosticsLoading={sessionDiagnosticsLoading}
            onEdit={(projectToEdit) => setEditingProject(projectToEdit)}
          />
        ) : (
          <>
            <header className="overview-heading">
              <div><p className="page-eyebrow">我的项目</p><h1>项目工作台</h1></div>
              {dashboard && <p className="overview-summary">{stats.total} 个项目 · {stats.attentionCount} 个待确认 · {stats.activeCount} 个会话接入或未交接</p>}
            </header>

            {!dashboard ? (
              <LoadingState notice={notice} />
            ) : projects.length === 0 && !dashboard.archivedProjects?.length ? (
              <EmptyState busy={busy} onChoose={() => chooseFolder()} />
            ) : (
              groups.length > 0 && (
                <section className="projects-section" aria-label="项目列表">
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
            {dashboard?.archivedProjects?.length > 0 && (
              <details className="archived-projects">
                <summary>已归档项目（{dashboard.archivedProjects.length}）</summary>
                <div className="workspace-list">
                  {dashboard.archivedProjects.map((project) => (
                    <article className="workspace-card" key={project.id}>
                      <strong>{project.name}</strong>
                      <div className="workspace-card-actions">
                        <Button variant="soft" size="sm" onClick={() => openProjectDetail(project)}>查看记录</Button>
                        <ManualRecordAction project={project} api={api} onSaved={refreshManualRecords} disabled={busy} />
                      </div>
                    </article>
                  ))}
                </div>
              </details>
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

      {spaceAction && (
        <SpaceActionModal
          action={spaceAction}
          busy={busy}
          onClose={() => setSpaceAction(null)}
          onConfirm={confirmSpaceAction}
        />
      )}

      {editingProject && (
        <EditProjectModal
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSave={saveProjectEdit}
        />
      )}

    </WorkbenchShell>
  );
}

function NoticeBanner({ notice, busy }) {
  if (!notice) return null;
  const variant = notice.tone === 'success' ? 'success' : 'error';
  return (
    <Alert variant={variant} className="notice-banner" role="alert">
      <AlertIcon />
      <div className="notice-body">
        <AlertTitle>{notice.message}</AlertTitle>
        {notice.impact && (
          <AlertDescription><strong>影响：</strong>{notice.impact}</AlertDescription>
        )}
        {notice.required_action && (
          <AlertDescription><strong>下一步：</strong>{notice.required_action}</AlertDescription>
        )}
      </div>
      {notice.actionLabel && notice.retry && (
        <Button
          variant="soft"
          size="sm"
          className="notice-btn"
          onClick={notice.retry}
          disabled={busy}
        >
          {notice.actionLabel}
        </Button>
      )}
    </Alert>
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
      <Spinner className="text-primary" style={{ width: 28, height: 28 }} aria-hidden="true" />
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
        <Button
          variant="primary"
          size="lg"
          onClick={onChoose}
          disabled={busy}
        >
          {busy
            ? (<><Spinner variant="dots" currentColor data-icon="start" />正在等待你选择…</>)
            : '选择项目文件夹'}
        </Button>
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
  const avatarColor = useProjectAvatarColor(project);
  const avatarColorStyle = getProjectCardAvatarColorStyle(avatarColor);
  const avatarUrl = projectAvatarUrl(project);
  const agent = project.activeWork?.agent
    ?? project.waitingAgent?.agent
    ?? project.pendingAssignment?.agent
    ?? project.activeRun?.agentClaim
    ?? null;
  const confirmedAt = project.activeWork?.lastProgress?.createdAt
    ?? project.activeWork?.lastActivityAt
    ?? project.lastObservedAt;
  const progressSummary = project.activeWork?.lastProgress?.note
    || project.activeRelay?.summary
    || project.activeWork?.task
    || project.waitingAgent?.task
    || project.pendingAssignment?.task
    || project.activeRun?.goal
    || project.lastHandoff?.summary
    || project.lastHandoffManual?.summary;
  const showStage = project.stage && project.stage !== 'development';

  return (
    <article
      className={['project-card', `status-${theme}`, avatarColorStyle.className].filter(Boolean).join(' ')}
      style={avatarColorStyle.style}
    >
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

        <div className="card-name-row">
          <ProjectAvatar project={project} avatarUrl={avatarUrl} size={40} />
          <h4 className="card-name">{project.name}</h4>
        </div>
        {showStage && (
          <Badge variant="soft" size="sm" className="stat-neutral card-stage-badge">
            {STAGES[project.stage] || project.stage}
          </Badge>
        )}
        <p className="card-what">{(progressSummary || copy.title).split(/\r?\n/)[0]}</p>
        {theme === 'attention' && <p className="card-impact">{copy.detail}</p>}
      </button>

      <footer className="card-foot">
        <span className="card-agent">{agent ? `${agent}` : '暂无 AI 会话'}</span>
        {isDisabled ? (
          <span className="read-only-action">{actionLabel}</span>
        ) : (
          <Button
            variant="soft"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onAction(project);
            }}
          >
            {actionLabel}
          </Button>
        )}
      </footer>
    </article>
  );
}

function ProjectDetailPage({ state, projectId, invalidRoute, onBack, onRetry, onLoadOlder, busy, onCreateSpace, onAssignSpace, onReuseSpace, onRemoveSpace, pendingWorkspaceActions, workspaceActionStorageError, onRecoverWorkspaceAction, onCopyReviewPrompt, onNoteStatusChange, onRecordsChanged, onLoadDiagnostics, diagnostics, diagnosticsLoading, onEdit }) {
  const titleRef = useRef(null);
  const project = state?.data?.project ?? state?.seed ?? {
    id: projectId,
    name: '项目详情',
    stage: 'development',
  };
  const effectiveProjectId = projectId || project.id;
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
          <div className="detail-identity-row">
            <ProjectAvatar
              project={project}
              avatarUrl={project.avatarPath
                ? `/api/v1/projects/${encodeURIComponent(effectiveProjectId)}/avatar?path=${encodeURIComponent(project.avatarPath)}`
                : null}
              size={48}
            />
            <div className="detail-title-group">
              <div className="detail-title-action-row">
                <h2 id="project-detail-title" ref={titleRef} tabIndex="-1">{project.name}</h2>
                {onEdit && !invalidRoute && (
                  <Button
                    variant="soft"
                    size="sm"
                    onClick={() => onEdit({ ...project, id: effectiveProjectId })}
                    disabled={busy}
                  >
                    编辑项目
                  </Button>
                )}
                {state?.data && <ManualRecordAction project={project} api={api} onSaved={onRecordsChanged} disabled={busy} />}
              </div>
              <div className="detail-kicker-row">
                {project.archivedAt && <Badge variant="soft" size="sm" className="stat-neutral">已归档</Badge>}
                {project.stage && (
                  <Badge variant="soft" size="sm" className="stat-neutral">
                    {STAGES[project.stage] || project.stage}
                  </Badge>
                )}
                <Badge variant="soft" size="sm" className="detail-status-badge">{eyebrow}</Badge>
              </div>
              <p>{headingCopy}</p>
            </div>
          </div>
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
            key={effectiveProjectId}
            data={state.data}
            loadingMore={state.loadingMore}
            loadError={state.error}
            onLoadOlder={onLoadOlder}
            actionNotice={state.actionNotice}
            busy={busy}
            onCreateSpace={onCreateSpace}
            onAssignSpace={onAssignSpace}
            onReuseSpace={onReuseSpace}
            onRemoveSpace={onRemoveSpace}
            pendingWorkspaceActions={pendingWorkspaceActions}
            workspaceActionStorageError={workspaceActionStorageError}
            onRecoverWorkspaceAction={onRecoverWorkspaceAction}
            onCopyReviewPrompt={onCopyReviewPrompt}
            onNoteStatusChange={onNoteStatusChange}
            onRecordsChanged={onRecordsChanged}
            onLoadDiagnostics={onLoadDiagnostics}
            diagnostics={diagnostics}
            diagnosticsLoading={diagnosticsLoading}
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
      <div className="detail-skeleton" aria-hidden="true">
        <Skeleton effect="shimmer" className="detail-skeleton-title" />
        <Skeleton effect="shimmer" className="detail-skeleton-line" />
        <Skeleton effect="shimmer" className="detail-skeleton-short" />
      </div>
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
      <Button variant="soft" className="ugk-retry" onClick={onRetry}>{retryLabel}</Button>
    </div>
  );
}

function SubmitHelp() {
  const [copied, setCopied] = useState(false);
  return (
    <details className="submit-help-details">
      <summary>外部或已有分支如何发布工作说明？</summary>
      <p>在任意已授权的代码分支或审核副本会话中输入 $cockpit-submit 发布工作说明。AI 会根据当前上下文整理进展与待办，不需要假设任务已完成，不默认执行保存、上传或预检。</p>
      <Button
        variant="soft"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(SUBMIT_MESSAGE);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? '指令已复制' : '复制发布说明指令'}
      </Button>
      <pre>{SUBMIT_MESSAGE}</pre>
      <p>外部机器无法连接本机平台时，交付消息只表示“待接入”，不能当作平台已收到。</p>
    </details>
  );
}

function ProjectDetailContent({ data, loadingMore, loadError, onLoadOlder, actionNotice, busy, onCreateSpace, onAssignSpace, onReuseSpace, onRemoveSpace, pendingWorkspaceActions = [], workspaceActionStorageError = null, onRecoverWorkspaceAction, onCopyReviewPrompt, onNoteStatusChange, onRecordsChanged, onLoadDiagnostics, diagnostics, diagnosticsLoading }) {
  const { project, timeline, developmentSpaces = [], submissions = [] } = data;
  const projectPendingWorkspaceActions = pendingWorkspaceActions.filter((item) => item.projectId === project.id);
  const [activeTab, setActiveTab] = useState('timeline');
  const tabRefs = useRef([]);
  const [focusedLaneKey, setFocusedLaneKey] = useState(null);
  const selectedContext = data.workLineContexts?.find((context) => context.laneKey === (focusedLaneKey || 'main'));
  const timelineItems = Array.isArray(timeline?.items) ? timeline.items : [];
  const timelineLanes = useMemo(() => getTimelineLanes(timeline, timelineItems), [timeline, timelineItems]);
  const selectedLane = timelineLanes.find((lane) => lane.key === focusedLaneKey);
  const selectedLineState = data.workLineStates?.find((state) => state.worktreeId === selectedLane?.worktreeId);
  const timelineEntries = useMemo(
    () => getTimelineEntries(timeline, timelineLanes),
    [timeline, timelineLanes],
  );

  useEffect(() => {
    if (focusedLaneKey && !timelineLanes.some((lane) => lane.key === focusedLaneKey)) {
      setFocusedLaneKey(null);
    }
  }, [focusedLaneKey, timelineLanes]);

  const tabs = [
    { id: 'timeline', label: '工作线' },
    { id: 'notes', label: '工作说明' },
    { id: 'spaces', label: '开发空间' },
  ];
  function handleTabKeyDown(event, index) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <>
      {actionNotice && (
        <Alert
          variant={actionNotice.error ? 'error' : 'success'}
          className="detail-action-notice"
          role="status"
        >
          <AlertIcon />
          <div className="notice-body">
            <AlertTitle>{actionNotice.message}</AlertTitle>
            {actionNotice.detail && <AlertDescription>{actionNotice.detail}</AlertDescription>}
          </div>
        </Alert>
      )}

      {workspaceActionStorageError && (
        <Alert variant="error" className="detail-action-notice" role="alert">
          <AlertIcon />
          <div className="notice-body">
            <AlertTitle>开发空间操作恢复材料暂时无法读取。</AlertTitle>
            <AlertDescription>没有发送新的开发空间操作。请先恢复本站点存储权限，再刷新当前项目。</AlertDescription>
          </div>
        </Alert>
      )}

      <div className="project-tabs" role="tablist" aria-label="项目内容">
        {tabs.map((tab, index) => (
          <button key={tab.id} type="button" role="tab"
            id={`project-tab-${tab.id}`} aria-controls={`project-panel-${tab.id}`}
            aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1}
            ref={(element) => { tabRefs.current[index] = element; }}
            onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}
          >{tab.label}</button>
        ))}
      </div>
      <div className="workspace-layout">
        <div className="workspace-main">
          <div className="workspace-panel" id="project-panel-timeline" role="tabpanel" aria-labelledby="project-tab-timeline" tabIndex={0} hidden={activeTab !== 'timeline'}>
            <section className="timeline-section" aria-labelledby="timeline-title">
              <div className="timeline-heading">
                <div>
                  <span className="timeline-overline">WORK HISTORY</span>
                  <h3 id="timeline-title">开发足迹</h3>
                  <p>最新进展在上方，点击历史摘要查看详情。</p>
                </div>
                <span className="timeline-count">已显示 {timelineItems.length} / {timeline.total} 条记录</span>
              </div>

              <TimelineLaneControls
                lanes={timelineLanes}
                workLineStates={data.workLineStates}
                focusedLaneKey={focusedLaneKey}
                onFocusLane={setFocusedLaneKey}
              />

              <WorkContext
                context={selectedContext}
                label={focusedLaneKey ? (timelineLanes.find((lane) => lane.key === focusedLaneKey)?.label || '所选工作线') : '项目总览'}
                overview={focusedLaneKey ? null : {
                  lineCount: timelineLanes.filter((lane) => ['development_space', 'delivery_source'].includes(lane.role)).length,
                  closedCount: data.workLineStates?.filter((line) => line.status === 'closed').length || 0,
                }}
                formatTime={formatTime}
              />
              {selectedLane && ['development_space', 'delivery_source'].includes(selectedLane.role) && (
                <div className="work-line-record-actions">
                  <span>{selectedLineState?.status === 'closed' ? '已由你手动结束' : '尚未手动结束'}</span>
                  <ManualRecordAction
                    project={project}
                    workLine={{ ...selectedLane, status: selectedLineState?.status || 'open', revision: selectedLineState?.revision || 0 }}
                    api={api}
                    onSaved={onRecordsChanged}
                    disabled={busy}
                  />
                </div>
              )}

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
                  <Button variant="soft" onClick={onLoadOlder} disabled={loadingMore}>
                    {loadingMore
                      ? (<><Spinner variant="dots" currentColor data-icon="start" />正在加载…</>)
                      : '加载更早记录'}
                  </Button>
                </div>
              )}
            </section>
          </div>
          <div className="workspace-panel" id="project-panel-notes" role="tabpanel" aria-labelledby="project-tab-notes" tabIndex={0} hidden={activeTab !== 'notes'}>
            {/* 独立“工作说明”收件箱 */}
            <SubmitNotesInbox
              key={project.id}
              projectId={project.id}
              api={api}
              onNoteStatusChange={onNoteStatusChange}
            />

            <SubmitHelp />

            {/* 旧版代码送审记录（明确标识并默认折叠，保留原有API与历史） */}
            <details className="legacy-review-details">
              <summary>旧版代码送审记录（共 {submissions.length} 条）</summary>
              {submissions.length === 0 ? (
                <p className="workspace-empty" style={{ marginTop: '10px' }}>当前没有旧版代码送审记录。</p>
              ) : (
                <div className="workspace-list" style={{ marginTop: '10px' }}>
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
                        <Button variant="primary" size="sm" onClick={() => onCopyReviewPrompt(submission)}>
                          复制审核提示词
                        </Button>
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
            </details>

          </div>
          <div className="workspace-panel" id="project-panel-spaces" role="tabpanel" aria-labelledby="project-tab-spaces" tabIndex={0} hidden={activeTab !== 'spaces'}>
            <section className="workspace-section" aria-labelledby="workspace-title">
              <div className="workspace-heading">
                <div>
                  <span className="timeline-overline">DEVELOPMENT SPACES</span>
                  <h3 id="workspace-title">功能开发空间</h3>
                  <p>完成的空间可以重新开始，也可以删除本地副本来释放空间。</p>
                </div>
                <Button variant="soft" size="sm" onClick={onCreateSpace} disabled={busy}>
                  {busy
                    ? (<><Spinner variant="dots" currentColor data-icon="start" />正在处理…</>)
                    : '新建开发空间'}
                </Button>
              </div>
              {projectPendingWorkspaceActions.length > 0 && (
                <div className="workspace-recovery-list" aria-label="待核对的开发空间操作">
                  {projectPendingWorkspaceActions.map((record) => (
                    <Alert variant="info" className="workspace-recovery-notice" role="status" key={record.id}>
                      <AlertIcon />
                      <div className="notice-body">
                        <AlertTitle>{record.spaceName || '这个开发空间'}的{record.kind === 'reuse' ? '重新开始' : '删除空间'}待核对</AlertTitle>
                        <AlertDescription>上次请求的结果没有确认。恢复时会继续使用同一个请求号和参数，不会生成新的开发空间操作。</AlertDescription>
                      </div>
                      <Button
                        variant="soft"
                        size="sm"
                        className="notice-btn"
                        onClick={() => onRecoverWorkspaceAction?.(record)}
                        disabled={busy || Boolean(workspaceActionStorageError)}
                      >
                        恢复并核对
                      </Button>
                    </Alert>
                  ))}
                </div>
              )}
              {developmentSpaces.length === 0 ? (
                <p className="workspace-empty">还没有开发空间。需要并行做功能时再创建即可。</p>
              ) : (
                <div className="workspace-list">
                  {developmentSpaces.map((space) => {
                    const pendingAction = projectPendingWorkspaceActions.find((item) => item.spaceId === space.spaceId);
                    return (
                      <article className="workspace-card" key={space.spaceId}>
                        <div>
                          <strong>{space.name}</strong>
                          <span>{space.statusReason === 'removed_by_user' ? '本地副本已删除，工作记录已保留' : space.status === 'archived' ? '已归档' : space.status === 'awaiting_review' ? '等待主项目审核' : space.status === 'cleanup_ready' ? '已完成，可以重新开始或删除' : '可以继续开发'}</span>
                        </div>
                        <div className="workspace-card-actions">
                          {pendingAction ? (
                            <span className="read-only-action">操作待核对</span>
                          ) : space.status === 'ready' && (
                            <Button variant="soft" size="sm" onClick={() => onAssignSpace(space)} disabled={busy || Boolean(workspaceActionStorageError)}>
                              复制接入消息
                            </Button>
                          )}
                          {!pendingAction && ['ready', 'cleanup_ready', 'paused', 'attention'].includes(space.status) && (
                            <>
                              <Button variant="soft" size="sm" onClick={() => onReuseSpace(space)} disabled={busy || Boolean(workspaceActionStorageError)}>
                                重新开始
                              </Button>
                              <Button variant="soft" size="sm" className="workspace-remove-button" onClick={() => onRemoveSpace(space)} disabled={busy || Boolean(workspaceActionStorageError)}>
                                删除空间
                              </Button>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

          </div>
        </div>
        <aside className="workspace-context" aria-label="项目会话管理">
          <details className="project-tech-panel">
            <summary>技术详情</summary>
            <dl>
              <div><dt>代码位置</dt><dd>{project.path}</dd></div>
              <div><dt>项目 ID</dt><dd>{project.id}</dd></div>
            </dl>
          </details>
          <SessionDiagnosticsPanel
            projectId={project.id}
            diagnostics={diagnostics}
            loading={diagnosticsLoading}
            onLoad={onLoadDiagnostics}
          />
          <ConversationControlPanel key={project.id} projectId={project.id} />
        </aside>
      </div>
    </>
  );
}

function ConversationControlPanel({ projectId }) {
  const [chains, setChains] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/conversation-control`;

  useEffect(() => () => { requestRef.current += 1; }, []);

  async function refresh() {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api(path);
      if (request === requestRef.current) setChains(result.chains);
    } catch (failure) {
      if (request === requestRef.current) setError(failure);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  return (
    <section className="context-section conversation-control" aria-label="会话接续与转交">
      <h3>会话接续与转交</h3>
      <p>按工作会话分别查看最后节点。接手成功本身就是新节点；不会改写此前成果的归属。</p>
      <Button variant="soft" size="sm" onClick={refresh} disabled={loading}>
        {loading ? '正在读取…' : '刷新会话接续情况'}
      </Button>
      {error && <ConversationControlError error={error} />}
      {chains?.length === 0 && <p>当前项目尚无工作会话。</p>}
      {chains?.map((chain) => (
        <ConversationControlChain key={chain.sessionId} chain={chain} path={path} onRefresh={refresh} />
      ))}
    </section>
  );
}

function ConversationControlError({ error }) {
  return <div role="alert" className="conversation-control-error">
    <p>{error.message || '操作未完成。'}</p>
    <p>{error.impact || '项目代码不会被清理或覆盖。'}</p>
    <p>{error.required_action || '请刷新会话状态核对结果；不要反复签发新授权。'}</p>
  </div>;
}

function ConversationControlChain({ chain, path, onRefresh }) {
  const [dialog, setDialog] = useState(null);
  const [targetHost, setTargetHost] = useState('');
  const [targetConversationId, setTargetConversationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [issued, setIssued] = useState(null);
  const [requestNotice, setRequestNotice] = useState('');
  const [copied, setCopied] = useState('');
  const pendingRequest = useRef(null);
  const owner = chain.owner;
  const node = chain.latestNode;
  const waiting = Boolean(chain.transfer);
  const actionable = ['active', 'awaiting_resume'].includes(chain.status);
  const nodeLabels = { init: '接入', accept: '接入', progress: '工作进展', relay: '准备接力', resume: '接收接力', takeover: '接手', handoff: '结束阶段', transfer_authorized: '用户授权转交', transfer_cancelled: '用户取消转交' };

  useEffect(() => {
    if (issued && chain.revision > issued.revision) setIssued(null);
  }, [chain.revision, issued]);

  async function copy(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied('复制失败，请手动选择文字复制。');
    }
  }

  async function submit(retry = false) {
    if (busy) return;
    if (!retry) {
      if (dialog === 'transfer' && Boolean(targetHost.trim()) !== Boolean(targetConversationId.trim())) {
        setError({ message: '目标平台和会话 ID 必须同时填写，或同时留空。' });
        return;
      }
      pendingRequest.current = {
        action: dialog,
        body: {
          clientRequestId: crypto.randomUUID(),
          expectedRevision: chain.revision,
          ...(dialog === 'cancel' ? { restorePreviousOwner: true } : targetHost.trim() ? {
            targetHost: targetHost.trim().toLowerCase(), targetConversationId: targetConversationId.trim(),
          } : {}),
        },
      };
    }
    const request = pendingRequest.current;
    if (!request) return;
    setBusy(true);
    setError(null);
    setCopied('');
    setRequestNotice('');
    try {
      const result = await api(`${path}/${encodeURIComponent(chain.sessionId)}/${request.action}`, {
        method: 'POST', body: JSON.stringify(request.body),
      });
      const hasCurrentAuthorization = request.action === 'transfer' && Boolean(result.transferCode);
      setIssued(hasCurrentAuthorization ? result : null);
      if (request.action === 'transfer' && !hasCurrentAuthorization) {
        const statusLabels = { consumed: '已被接手', cancelled: '已取消', expired: '已过期', superseded: '已被后续授权替代' };
        setRequestNotice(`历史请求已处理：${statusLabels[result.currentStatus] || '不再提供有效接手授权'}。正在刷新当前会话状态；不能使用该历史请求接手。`);
      } else if (request.action === 'cancel') {
        setRequestNotice('取消请求已处理。请以刷新后的当前会话状态为准。');
      }
      pendingRequest.current = null;
      setDialog(null);
      await onRefresh();
    } catch (failure) {
      setError(failure);
      // Keep the exact request for an uncertain-result retry; never mint a new authorization automatically.
      if (failure.code && !['SERVICE_UNAVAILABLE', 'AUTH_REQUIRED'].includes(failure.code)) pendingRequest.current = null;
    } finally {
      setBusy(false);
    }
  }

  return <article className="conversation-chain">
    <h4>{chain.task || '未命名工作会话'}</h4>
    <dl>
      <div><dt>工作会话</dt><dd>{chain.sessionId}</dd></div>
      <div><dt>当前接续</dt><dd>{waiting ? '等待用户授权的聊天接手' : chain.status === 'active' ? '进行中' : chain.status === 'awaiting_resume' ? '等待接力接收' : chain.status === 'standby' ? '待继续（当前不可转交）' : '已结束'}</dd></div>
      <div><dt>持有人</dt><dd>{owner?.host || '此前连接'} / {owner?.conversationLocator || '无法定位具体聊天'}</dd></div>
      <div><dt>最后节点</dt><dd>{node ? `${nodeLabels[node.type] || '工作流操作'} · ${node.actorHost || (node.actorKind === 'user' ? '项目所有者' : node.actorKind === 'system' ? '系统' : '历史身份未知')}${node.actorConversationId ? ` / ${node.actorConversationId}` : ''}` : '历史记录未提供节点信息'}</dd></div>
      {node && <div><dt>节点内容</dt><dd>{node.summary || '未提供摘要'} · {formatTime(node.createdAt)}</dd></div>}
    </dl>
    {owner?.conversationLocator && <Button size="sm" variant="soft" onClick={() => copy(`${owner.host || '未知平台'} / ${owner.conversationLocator}`, '已复制持有人身份')}>复制平台与会话 ID</Button>}
    {waiting && <p>授权{chain.transfer.status === 'expired' ? '已过期' : `有效至 ${formatTime(chain.transfer.expiresAt)}`}。旧聊天已冻结；过期不会自动恢复旧聊天，也不会向其他聊天开放。</p>}
    <div className="conversation-control-actions">
      {actionable && <Button size="sm" variant="soft" disabled={busy || Boolean(pendingRequest.current)} onClick={() => { setError(null); setDialog('transfer'); }}>授权其他聊天接手</Button>}
      {waiting && <Button size="sm" variant="soft" disabled={busy || Boolean(pendingRequest.current)} onClick={() => { setError(null); setDialog('cancel'); }}>取消转交并恢复原聊天</Button>}
      {pendingRequest.current && !busy && <Button size="sm" variant="soft" onClick={() => submit(true)}>以原请求核对 / 重试</Button>}
    </div>
    {issued && <div className="conversation-transfer-result">
      <p>授权已签发，有效至 {formatTime(issued.expiresAt)}。请只交给你希望接手的聊天。指令仅在本次页面中显示，不保存到浏览器存储。</p>
      <pre>{issued.continueMessage || issued.transferCode}</pre>
      <Button size="sm" variant="soft" onClick={() => copy(issued.continueMessage || issued.transferCode, '已复制接手指令')}>复制接手指令</Button>
    </div>}
    {copied && <p role="status">{copied}</p>}
    {requestNotice && <p role="status">{requestNotice}</p>}
    {error && <ConversationControlError error={error} />}
    <Dialog open={Boolean(dialog)} onOpenChange={createDialogCloseGuard(busy, () => setDialog(null))}>
      <DialogContent>
        <DialogHeader><DialogTitle>{dialog === 'cancel' ? '恢复原聊天的接续权限？' : '停止旧聊天推进并授权转交？'}</DialogTitle>
          <DialogDescription>目标：{chain.task || chain.sessionId}。代码不会被清理或覆盖。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p>当前持有人：{owner?.host || '此前连接'} / {owner?.conversationLocator || '无法定位具体聊天'}。</p>
          {dialog === 'cancel' ? <p>确认后撤销待接手授权，并恢复先前聊天的权限。若已有新聊天接手，本次取消将被拒绝。</p> : <>
            <p>确认后原聊天立即失去推进权。接手授权 10 分钟有效，超时仍保持待处理，必须由你重新授权或明确恢复原聊天。</p>
            <Field><FieldLabel htmlFor={`target-host-${chain.sessionId}`}>目标平台标识（可选）</FieldLabel><Input id={`target-host-${chain.sessionId}`} value={targetHost} onChange={(event) => setTargetHost(event.target.value)} placeholder="例如 zcode、codex" disabled={busy} /></Field>
            <Field><FieldLabel htmlFor={`target-chat-${chain.sessionId}`}>目标宿主会话 ID（与平台一起填写）</FieldLabel><Input id={`target-chat-${chain.sessionId}`} value={targetConversationId} onChange={(event) => setTargetConversationId(event.target.value)} disabled={busy} /></Field>
            <p>都留空时，持有一次性指令的聊天可以接手，请勿公开分享。</p>
          </>}
          {error && <ConversationControlError error={error} />}
          {pendingRequest.current && !busy && <Button variant="soft" onClick={() => submit(true)}>以原请求核对 / 重试</Button>}
        </DialogBody>
        <DialogFooter><Button variant="soft" disabled={busy} onClick={() => setDialog(null)}>返回</Button><Button disabled={busy || Boolean(pendingRequest.current)} onClick={() => submit()}>{busy ? '正在提交…' : dialog === 'cancel' ? '确认恢复原聊天' : '确认冻结并签发授权'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </article>;
}

function SessionDiagnosticsPanel({ projectId, diagnostics, loading, onLoad }) {
  const [copied, setCopied] = useState(false);
  const entries = Array.isArray(diagnostics?.entries) ? diagnostics.entries : [];

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ projectId, entries }, null, 2));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="project-tech-panel session-diagnostics-panel">
      <summary>近期会话诊断</summary>
      <p>只读取属于当前项目的已脱敏诊断记录；不会读取任意网页或项目文件。</p>
      <div className="session-diagnostics-actions">
        <Button variant="soft" size="sm" onClick={onLoad} disabled={loading}>
          {loading ? '正在读取…' : '读取近期记录'}
        </Button>
        {entries.length > 0 && (
          <Button variant="soft" size="sm" onClick={copyDiagnostics}>
            {copied ? '已复制脱敏诊断' : '复制脱敏诊断'}
          </Button>
        )}
      </div>
      {diagnostics?.error ? (
        <p className="session-diagnostics-error" role="alert">
          {diagnostics.error.message} {diagnostics.error.required_action}
        </p>
      ) : diagnostics && entries.length === 0 ? (
        <p className="session-diagnostics-empty">当前没有可显示的近期会话诊断。</p>
      ) : entries.length > 0 ? (
        <pre className="session-diagnostics-output">{JSON.stringify(entries, null, 2)}</pre>
      ) : (
        <p className="session-diagnostics-empty">展开后读取；日志只保留有限的近期记录。</p>
      )}
    </details>
  );
}

function TimelineLaneControls({ lanes, focusedLaneKey, onFocusLane, workLineStates = [] }) {
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
            <span>{lane.label}{workLineStates.some((line) => line.worktreeId === lane.worktreeId && line.status === 'closed') ? ' · 已结束' : ''}</span>
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
      style={{ width: geometry.railWidth, height: Math.max(1, geometry.height) }}
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
  const [expansion, setExpansion] = useState({ lane: focusedLaneKey, entries: new Map() });
  const expandedEntries = expansion.lane === focusedLaneKey ? expansion.entries : new Map();
  const latestEntry = entries.find((entry) => entry.entryKind === 'event'
    && (!focusedLaneKey || entry.laneKey === focusedLaneKey));
  const latestKey = latestEntry ? timelineEntryKey(latestEntry) : null;
  const dayLabel = (entry) => {
    if (entry.entryKind === 'origin-continuation') return '更早的来源';
    const date = new Date(entry.timestamp);
    return Number.isFinite(date.getTime())
      ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
      : '日期未记录';
  };

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return undefined;

    const measure = () => {
      const rootRect = history.getBoundingClientRect();
      const historyHeight = rootRect.height;
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
          historyHeight,
        })];
      }));
      setGeometry({
        railWidth,
        height: historyHeight,
        laneX: new Map(lanes.map((lane) => [lane.key, timelineLaneX(lane, lanes.length, railWidth)])),
        railEndY,
        points,
        connectorEndX,
      });
    };

    measure();
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure)
      : null;
    resizeObserver?.observe(history);
    for (const row of rowRefs.current.values()) resizeObserver?.observe(row);
    window.addEventListener('resize', measure);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [entries, lanes, focusedLaneKey, expansion]);

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
          const dateLabel = index === 0 || dayLabel(entry) !== dayLabel(entries[index - 1])
            ? dayLabel(entry) : null;
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
                dateLabel={dateLabel}
              />
            );
          }

          return (
            <TimelineNode
              key={timelineEntryKey(entry)}
              ref={setRowRef}
              item={entry}
              lane={lane}
              className={rowClass}
              style={rowStyle}
              focusedLaneKey={focusedLaneKey}
              onFocusLane={onFocusLane}
              dateLabel={dateLabel}
              isLatest={timelineEntryKey(entry) === latestKey}
              expanded={expandedEntries.get(timelineEntryKey(entry)) ?? timelineEntryKey(entry) === latestKey}
              onToggle={() => {
                const key = timelineEntryKey(entry);
                const next = new Map(expandedEntries);
                next.set(key, !(next.get(key) ?? key === latestKey));
                setExpansion({ lane: focusedLaneKey, entries: next });
              }}
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
  dateLabel,
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
      {dateLabel && <div className="timeline-date-divider">{dateLabel}</div>}
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
            <details>
              <summary>来源详情</summary>
              <small>
                创建时采用的基线 {baseCommit ? <code>{baseCommit}</code> : '未记录'}
                {origin.branch ? <> · 工作线 <code>{origin.branch}</code></> : ''}
              </small>
            </details>
          </>
        )}
      </article>
    </li>
  );
});

const TimelineNode = React.forwardRef(function TimelineNode({
  item,
  lane,
  className,
  style,
  focusedLaneKey,
  onFocusLane,
  dateLabel,
  isLatest,
  expanded,
  onToggle,
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
  const isSubmitNote = item.kind === 'submit_note';
  const isUserRecord = item.kind === 'work_line_closed' || item.kind === 'work_line_reopened';
  const hasCollapsibleContext = isRelayOrHandoff || item.kind === 'init' || isSubmitNote;
  const hasCounts = isRelayOrHandoff && (
    (item.completedItems?.length > 0) ||
    (item.pendingItems?.length > 0) ||
    (item.decisions?.length > 0) ||
    (item.risks?.length > 0)
  );
  const hasContextDetails = Boolean(
    (item.currentState && item.currentState !== item.summary) ||
    detailGroups.length > 0 ||
    (isSubmitNote && (item.body || item.note || item.references?.length > 0 || item.handlingNote))
  );

  const onCardClick = (event) => {
    if (event.target?.closest?.('button, a, summary, input, select, textarea, .timeline-expanded-content')) return;
    onToggle();
  };

  return (
    <li
      ref={ref}
      className={className}
      style={style}
      data-lane-key={lane.key}
      data-lane-role={lane.role}
    >
      {dateLabel && <div className="timeline-date-divider">{dateLabel}</div>}
      <article className={`timeline-bubble${expanded ? ' is-expanded' : ''}${isLatest ? ' is-latest' : ''}`} onClick={onCardClick}>
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
            {isLatest && <span className="timeline-latest-label">最新</span>}
          </div>
          <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
        </header>

        <h4 className="timeline-summary-heading">
          <button type="button" className="timeline-summary-toggle" aria-expanded={expanded}
            aria-controls={`timeline-content-${item.kind}-${item.id}`} onClick={onToggle}>
            <span className="timeline-summary-text">{item.summary || item.note || kind.label}</span>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          </button>
        </h4>
        <div className="timeline-expanded-content" id={`timeline-content-${item.kind}-${item.id}`} hidden={!expanded}>
          <div className="timeline-preview-meta">
            {isUserRecord && <span>用户操作记录</span>}
            {item.agent && <span>{item.agent}</span>}
            {relayInfo && <span>{relayInfo.label}</span>}
            {item.kind === 'handoff' && <span>阶段已交接</span>}
            {item.kind === 'integration' && <span>已确认接入主项目</span>}
            {isSubmitNote && <span>{noteStatusLabel(item.status)}</span>}
          </div>
          {item.nextSessionFocus && <p className="timeline-next-preview" title={item.nextSessionFocus}><span>下一步</span>{item.nextSessionFocus}</p>}
          {item.kind === 'progress' && item.details?.length > 0 && (
            <ul className="timeline-preview-list">{item.details.slice(0, 2).map((detail, index) => <li key={index}>{timelineDetailText(detail)}</li>)}</ul>
          )}
          <details className="timeline-record">
            <summary>完整记录与技术详情</summary>
            <p className="timeline-record-summary">{item.summary || item.note || kind.label}</p>
        <div className="timeline-context-row">
          {item.kind !== 'integration' && !isUserRecord && (
            <span className="timeline-agent">
              {isSubmitNote
                ? (item.agent ? `提交方 · ${item.agent}` : '提交方 · 未归属')
                : `AI · ${item.agent || '未记录'}`}
            </span>
          )}
          {isUserRecord ? <span>用户操作 · 保留代码与会话</span> : item.kind === 'integration' ? (
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
          {isSubmitNote && (
            <span className={`note-status-chip note-badge-${item.status || 'pending'}`}>
              {noteStatusLabel(item.status)}
            </span>
          )}
        </div>

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
                  : isSubmitNote
                    ? '查看说明正文与引用'
                    : '查看接入状态'}</summary>
              <div className="timeline-details-content">
                {isSubmitNote ? (
                  <div className="timeline-submit-note-details">
                    <p className="note-disclaimer">提示：说明与引用均为提交方原始资料，不构成平台背书或自动执行授权。</p>
                    <div className="note-body-text">{renderSafeTextWithLinks(item.body || item.note)}</div>
                    {item.references?.length > 0 && (
                      <div className="timeline-references-list" style={{ marginTop: '8px' }}>
                        <strong style={{ fontSize: '12px' }}>引用项（{item.references.length}）：</strong>
                        <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: '12px' }}>
                          {item.references.map((ref, rIdx) => (
                            <li key={rIdx}>
                              [{ref.type || '引用'}] {ref.target} {ref.commit ? `(commit: ${ref.commit.slice(0, 7)})` : ''} {ref.title ? `- ${ref.title}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {item.handlingNote && (
                      <div className="timeline-handling-note" style={{ marginTop: '8px', fontSize: '12px' }}>
                        <strong>处理备注：</strong>
                        <span>{renderSafeTextWithLinks(item.handlingNote)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
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
                  </>
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
                    <li key={`detail-${dIdx}`}>{timelineDetailText(detail)}</li>
                  ))}
                </ul>
                {item.details.length > 3 && (
                  <details className="timeline-details-expand">
                    <summary>查看更多详情（共 {item.details.length} 条）</summary>
                    <ul className="timeline-progress-details">
                      {item.details.slice(3).map((detail, dIdx) => (
                        <li key={`detail-more-${dIdx}`}>{timelineDetailText(detail)}</li>
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

        {!isSubmitNote && item.bodyMarkdown && (
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
          </details>
        </div>
      </article>
    </li>
  );
});

function ConfirmAddModal({ selection, onClose, onRegister, busy, notice }) {
  const [name, setName] = useState(selection?.folderName || '');
  const [stage, setStage] = useState('development');
  const handleOpenChange = createDialogCloseGuard(busy, onClose);

  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <DialogContent className="ugk-dialog" closeButton aria-labelledby="confirm-folder-title">
        <DialogHeader>
          <div className="modal-kicker-row">
            <Badge variant="soft" size="sm" className="badge-brand">安全确认 · 添加代码位置</Badge>
          </div>
          <DialogTitle id="confirm-folder-title">我们只会添加这一份代码</DialogTitle>
          <DialogDescription>确认只登记代码位置本身；你的文件不会被读取改动或上传。</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="modal-form">
            <div className="selection-info-box">
              <span className="info-label">已选择文件夹</span>
              <strong className="info-value">{selection.folderName}</strong>
            </div>

            <Alert variant="info">
              <AlertIcon />
              <div className="notice-body">
                <AlertTitle>安全边界保证</AlertTitle>
                <AlertDescription>{selection.promise}</AlertDescription>
              </div>
            </Alert>

            <Field>
              <FieldLabel>项目显示名称</FieldLabel>
              <Input
                variant="soft"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                maxLength={100}
              />
            </Field>

            <Field>
              <FieldLabel>当前阶段</FieldLabel>
              <Select
                items={STAGE_OPTIONS}
                value={stage}
                onValueChange={(value) => setStage(String(value))}
                disabled={busy}
              >
                <SelectTrigger className="w-full" aria-label="当前阶段">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <details className="modal-tech-details">
              <summary>查看技术位置</summary>
              <code>{selection.folderPath}</code>
            </details>

            {notice && <NoticeBanner notice={notice} busy={busy} />}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="soft"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => onRegister(name, stage)}
            disabled={busy || !name.trim()}
          >
            {busy
              ? (<><Spinner variant="dots" currentColor data-icon="start" />正在安全检查…</>)
              : '确认添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const handleOpenChange = createDialogCloseGuard(busy, onClose);
  const isAdoptMode = project?.pendingAssignment?.mode === 'adopt';

  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <DialogContent className="ugk-dialog" closeButton aria-labelledby="handoff-dialog-title">
        <DialogHeader>
          <div className="modal-kicker-row">
            <Badge variant="soft" size="sm" className="badge-brand">
              {dispatch ? '接入指令已就绪' : (isAdoptMode ? '重新生成接入指令' : '交给 AI')}
            </Badge>
          </div>
          <DialogTitle id="handoff-dialog-title">
            {isAdoptMode ? `${project.name} · 重新生成接入指令` : project.name}
          </DialogTitle>
          <DialogDescription>
            {dispatch
              ? '复制接入消息并发送给对应的 AI Agent 即可完成接手。'
              : '生成一次性接手指令；只有 Agent 成功接入后才会开始工作。'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {!dispatch ? (
            <div className="modal-form">
              {isAdoptMode && (
                <Alert variant="info">
                  <AlertIcon />
                  <div className="notice-body">
                    <AlertDescription>
                      该项目已有待接手的初始化任务，将为你重新生成有效的接入指令。
                    </AlertDescription>
                  </div>
                </Alert>
              )}

              <Field>
                <FieldLabel>交给哪位 AI Agent</FieldLabel>
                <Select
                  items={AGENT_OPTIONS}
                  value={agent}
                  onValueChange={(value) => setAgent(String(value))}
                  disabled={busy}
                >
                  <SelectTrigger className="w-full" aria-label="交给哪位 AI Agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel>
                  {isAdoptMode ? '本次任务目标（保留原目标）' : '本次任务目标（可选）'}
                </FieldLabel>
                <Textarea
                  variant="soft"
                  value={goal}
                  onChange={(e) => {
                    if (!isAdoptMode) setGoal(e.target.value);
                  }}
                  rows={3}
                  maxLength={1000}
                  placeholder="可以留空；例如：完成登录页的接口联调与异常处理"
                  disabled={busy}
                  readOnly={isAdoptMode}
                />
                {isAdoptMode && (
                  <FieldDescription>
                    重新生成只更新一次性接入码和接手 Agent；原任务目标保持不变。
                  </FieldDescription>
                )}
              </Field>

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
            </div>
          ) : (
            <div className="modal-form">
              <Alert variant="success">
                <AlertIcon />
                <div className="notice-body">
                  <AlertDescription>
                    接入指令已创建。请复制下方消息发送给 <strong>{agent}</strong>。
                    MCP 客户端连接成功后，控制台会自动刷新为“会话已接入”状态。
                  </AlertDescription>
                </div>
              </Alert>

              <Field>
                <FieldLabel>接入消息指令</FieldLabel>
                <Textarea
                  variant="soft"
                  className="dispatch-message"
                  value={dispatch.message}
                  readOnly
                  rows={8}
                />
              </Field>

              <div className="expiry-hint">
                接手码有效期至 <strong>{formatTime(dispatch.expiresAt)}</strong>。消息中不包含本地物理路径或主 API 密钥。
              </div>
            </div>
          )}

          {notice && <NoticeBanner notice={notice} busy={busy} />}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="soft"
            onClick={onClose}
            disabled={busy}
          >
            {dispatch ? '完成' : '取消'}
          </Button>
          {!dispatch ? (
            <Button
              variant="primary"
              onClick={onCreate}
              disabled={busy}
            >
              {busy
                ? (<><Spinner variant="dots" currentColor data-icon="start" />{isAdoptMode ? '正在重新生成…' : '正在创建…'}</>)
                : (isAdoptMode ? '重新生成接入指令' : '生成接入指令')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={onCopy}
            >
              复制接手消息
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ConfirmFolderModal = ConfirmAddModal;

function EditProjectModal({ project, onClose, onSave }) {
  const [name, setName] = useState(project?.name || '');
  const [avatarPath, setAvatarPath] = useState(project?.avatarPath || '');
  const [selecting, setSelecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const fileInputRef = useRef(null);
  const busy = selecting || saving;
  const handleOpenChange = createDialogCloseGuard(busy, onClose);

  function handleSelectImageClick() {
    if (busy) return;
    fileInputRef.current?.click();
  }

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      setNotice({
        tone: 'error',
        message: '仅支持 PNG、JPG、JPEG、GIF 或 WebP 图片。',
        impact: '项目头像未被修改，代码和已有记录不受影响。',
        requiredAction: '请选择支持的图片格式后重试。',
      });
      return;
    }
    if (file.size <= 0) {
      setNotice({
        tone: 'error',
        message: '所选头像文件为空。',
        impact: '项目头像未被修改，代码和已有记录不受影响。',
        requiredAction: '请选择有效的图片文件后重试。',
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setNotice({
        tone: 'error',
        message: '所选头像超过 5MB。',
        impact: '项目头像未被修改，代码和已有记录不受影响。',
        requiredAction: '请选择不超过 5MB 的图片后重试。',
      });
      return;
    }

    setSelecting(true);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/avatar/upload`, {
        method: 'POST',
        body: formData,
      });
      if (res?.cancelled) {
        return;
      }
      if (res?.avatarPath) {
        setAvatarPath(res.avatarPath);
      }
    } catch (err) {
      setNotice(createErrorNotice(err, {
        message: '上传项目头像失败。',
        impact: '项目头像未被修改，代码和已有记录不受影响。',
        requiredAction: '请确认选择有效的图片文件后重试。',
      }));
    } finally {
      setSelecting(false);
    }
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNotice({
        tone: 'error',
        message: '项目显示名称不能为空。',
        impact: '没有执行保存，原有设置未被修改。',
        required_action: '请输入有效的项目显示名称后再保存。',
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await onSave(project.id, {
        name: trimmed,
        avatarPath: avatarPath || '',
      });
    } catch (err) {
      setNotice(createErrorNotice(err, {
        message: '保存项目信息失败。',
        impact: '项目代码和已有记录不受影响。',
        requiredAction: '请检查输入内容后重试。',
      }));
      setSaving(false);
    }
  }

  const previewAvatarUrl = avatarPath
    ? `/api/v1/projects/${encodeURIComponent(project.id)}/avatar?path=${encodeURIComponent(avatarPath)}`
    : null;

  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <DialogContent className="ugk-dialog" closeButton aria-labelledby="edit-project-dialog-title">
        <DialogHeader>
          <div className="modal-kicker-row">
            <Badge variant="soft" size="sm" className="badge-brand">项目设置 · 识别与头像</Badge>
          </div>
          <DialogTitle id="edit-project-dialog-title">编辑项目信息</DialogTitle>
          <DialogDescription>修改显示名称与头像；项目代码位置保持不变。</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            disabled={busy}
          />
          <div className="modal-form">
            <Field>
              <FieldLabel>项目显示名称</FieldLabel>
              <Input
                variant="soft"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                maxLength={100}
                placeholder="请输入项目显示名称"
              />
            </Field>

            <Field>
              <FieldLabel>项目头像</FieldLabel>
              <div className="avatar-preview-row">
                {previewAvatarUrl ? (
                  <div className="avatar-preview-box">
                    <ProjectAvatar project={project} avatarUrl={previewAvatarUrl} size={56} />
                    <div className="avatar-preview-info">
                      <div className="avatar-preview-actions">
                        <Button
                          variant="soft"
                          size="sm"
                          onClick={handleSelectImageClick}
                          disabled={busy}
                        >
                          {selecting ? '正在上传…' : '选择图片'}
                        </Button>
                        <Button
                          variant="soft"
                          size="sm"
                          onClick={() => setAvatarPath('')}
                          disabled={busy}
                        >
                          移除头像
                        </Button>
                      </div>
                      <span className="avatar-preview-path" title={avatarPath}>{avatarPath}</span>
                    </div>
                  </div>
                ) : (
                  <div className="avatar-preview-box">
                    <ProjectAvatar project={{ name }} avatarUrl={null} size={56} />
                    <div className="avatar-preview-info">
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={handleSelectImageClick}
                        disabled={busy}
                      >
                        {selecting ? '正在上传…' : '选择图片'}
                      </Button>
                      <FieldDescription>未选择头像，使用名称前两字作为默认图标</FieldDescription>
                    </div>
                  </div>
                )}
              </div>
              <FieldDescription>
                支持 PNG、JPG、JPEG、GIF 或 WebP 图片（上限 5MB）。
              </FieldDescription>
            </Field>

            {notice && <NoticeBanner notice={notice} busy={busy} />}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="soft"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={busy || !name.trim()}
          >
            {saving
              ? (<><Spinner variant="dots" currentColor data-icon="start" />正在保存…</>)
              : '保存设置'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SpaceActionModal({ action, busy, onClose, onConfirm }) {
  const isReuse = action.kind === 'reuse';
  const handleOpenChange = createDialogCloseGuard(busy, onClose);
  const spaceName = action.space.name || '这个开发空间';

  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <DialogContent className="ugk-dialog" closeButton aria-labelledby="space-action-dialog-title">
        <DialogHeader>
          <div className="modal-kicker-row">
            <Badge variant="soft" size="sm" className={isReuse ? 'badge-brand' : 'workspace-remove-badge'}>
              {isReuse ? '重新开始开发空间' : '删除本地开发空间'}
            </Badge>
          </div>
          <DialogTitle id="space-action-dialog-title">
            {isReuse ? `重新开始 ${spaceName}` : `删除 ${spaceName}`}
          </DialogTitle>
          <DialogDescription>
            {isReuse
              ? '会为这个空间开始一条新的工作线，基于主项目当前可见的本地版本。'
              : '会移除这个空间的本地工作副本，释放它占用的电脑空间。'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="modal-form">
            <Alert variant={isReuse ? 'info' : 'error'}>
              <AlertIcon />
              <div className="notice-body">
                <AlertTitle>{isReuse ? '原来的工作不会丢失' : '删除前会再次核对代码状态'}</AlertTitle>
                <AlertDescription>
                  {isReuse
                    ? '只有空间干净且没有正在进行的 AI 工作时才会切换；之前的工作线会保留，方便需要时找回。'
                    : '只有空间干净且没有正在进行的 AI 工作时才会删除；之前的工作线和项目记录会保留，方便需要时找回。'}
                </AlertDescription>
              </div>
            </Alert>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="soft" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant={isReuse ? 'primary' : 'soft'}
            className={isReuse ? undefined : 'workspace-remove-button'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy
              ? (<><Spinner variant="dots" currentColor data-icon="start" />正在处理…</>)
              : (isReuse ? '确认重新开始' : '确认删除空间')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmFolderModal, ConfirmAddModal, EditProjectModal };

createRoot(document.getElementById('root')).render(<App />);
