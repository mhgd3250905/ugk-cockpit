import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@appica/ui-react/button';
import { Badge } from '@appica/ui-react/badge';
import { Tabs, TabsList, TabsTrigger } from '@appica/ui-react/tabs';
import { Textarea } from '@appica/ui-react/textarea';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from '@appica/ui-react/alert';
import { Spinner } from '@appica/ui-react/spinner';
import { noteStatusLabel } from './delivery-view.mjs';

const PAGE_SIZE = 30;
const e = React.createElement;

export function renderSafeTextWithLinks(text) {
  if (typeof text !== 'string') return null;
  const urlRegex = /(https?:\/\/[^\s<>"'，。！？；、（）()]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, index) => {
    if (/^https?:\/\//i.test(part)) {
      return e('a', {
        key: index,
        href: part,
        target: '_blank',
        rel: 'noopener noreferrer',
        className: 'safe-external-link',
      }, part);
    }
    return part;
  });
}

function formatNoteTime(isoString) {
  if (!isoString) return '未记录时间';
  const parsed = Date.parse(isoString);
  if (Number.isNaN(parsed)) return isoString;
  const date = new Date(parsed);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function generateRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'req_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function buildNoteStatusRequest(item, status, draft, previous = null) {
  if (previous) return previous;
  return Object.freeze({
    clientRequestId: generateRequestId(), expectedRevision: item.revision, status,
    ...(draft !== undefined ? { handlingNote: draft } : {}),
  });
}

export function requireNoteStatusReceipt(result, noteId) {
  if (result?.ok === true && result.note?.noteId === noteId
      && Number.isInteger(result.note.revision) && result.note.revision > 0) return result.note;
  throw Object.assign(new Error('尚未确认说明状态是否已更新。'), {
    code: result?.code || 'SERVICE_UNAVAILABLE',
  });
}

export function noteActionError(error, targetStatus) {
  const retryable = !error.code || ['SERVICE_UNAVAILABLE', 'REQUEST_FAILED'].includes(error.code);
  return {
    code: error.code || 'SERVICE_UNAVAILABLE', message: error.message || '更新说明状态失败',
    impact: error.impact || '代码不受影响；尚未确认本次说明状态更新成功。',
    required_action: retryable ? '请按原请求重试，不要新建一次状态操作。'
      : error.code === 'NOTE_REVISION_CONFLICT' ? '已重新读取记录；核对最新状态后再选择操作。'
        : error.required_action || '请核对提示后再操作。',
    retryable, targetStatus,
  };
}

const STATUS_TABS = [
  { value: 'pending', label: '待处理' },
  { value: 'handled', label: '已处理' },
  { value: 'archived', label: '已归档' },
];

export function SubmitNotesInbox({ projectId, api, onNoteStatusChange }) {
  const [statusFilter, setStatusFilter] = useState('pending');
  const [page, setPage] = useState(0);
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ pending: 0, handled: 0, archived: 0 });
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [draftRemarks, setDraftRemarks] = useState({});
  const [busyNotes, setBusyNotes] = useState({});
  const [actionErrors, setActionErrors] = useState({});
  const lastRequestsRef = useRef({});
  const pendingWritesRef = useRef(new Set());
  const [copiedNotes, setCopiedNotes] = useState({});

  const requestSeqRef = useRef(0);
  const isMountedRef = useRef(true);
  const fetchNotesRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // When project changes, reset page and filter
  useEffect(() => {
    setPage(0);
    setStatusFilter('pending');
    setDraftRemarks({});
    setActionErrors({});
  }, [projectId]);

  const fetchNotes = useCallback(async (isPolling = false) => {
    if (!projectId || !api) return;
    const seq = ++requestSeqRef.current;
    if (!isPolling) setLoading(true);

    try {
      const offset = page * PAGE_SIZE;
      const url = `/api/v1/projects/${encodeURIComponent(projectId)}/submit-notes?status=${encodeURIComponent(statusFilter)}&limit=${PAGE_SIZE}&offset=${offset}`;
      const data = await api(url);

      if (!isMountedRef.current || seq !== requestSeqRef.current) {
        return; // Discard stale response
      }

      setItems(data.items || []);
      setCounts(data.counts || { pending: 0, handled: 0, archived: 0 });
      setTotal(typeof data.total === 'number' ? data.total : (data.items?.length || 0));
      setHasMore(Boolean(data.hasMore));
      setError(null);
    } catch (err) {
      if (!isMountedRef.current || seq !== requestSeqRef.current) return;
      setError(err);
    } finally {
      if (isMountedRef.current && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [projectId, api, statusFilter, page]);
  fetchNotesRef.current = fetchNotes;

  useEffect(() => {
    setItems([]);
    fetchNotes(false);
  }, [fetchNotes]);

  // Polling every 4.5s keeps filter, page, and uncommitted draftRemarks
  useEffect(() => {
    if (!projectId || !api) return;
    const timer = setInterval(() => {
      fetchNotes(true);
    }, 4500);
    return () => clearInterval(timer);
  }, [fetchNotes, projectId, api]);

  async function handleCopy(item) {
    try {
      if (!item.copyText) throw new Error('缺少完整处理说明，请重新加载后再复制。');
      await navigator.clipboard.writeText(item.copyText);
      if (!isMountedRef.current) return;
      setCopiedNotes((prev) => ({ ...prev, [item.noteId]: true }));
      setTimeout(() => {
        if (isMountedRef.current) setCopiedNotes((prev) => ({ ...prev, [item.noteId]: false }));
      }, 2500);
    } catch (error) {
      if (!isMountedRef.current) return;
      setCopiedNotes((prev) => ({ ...prev, [item.noteId]: false }));
      setActionErrors((prev) => ({ ...prev, [item.noteId]: prev[item.noteId]?.retryable ? prev[item.noteId] : {
        message: '复制未成功，请检查剪贴板权限或重新加载。', retryable: false,
      } }));
    }
  }

  async function handleStatusUpdate(item, targetStatus, isRetry = false) {
    const noteId = item.noteId;
    if (pendingWritesRef.current.has(noteId)) return;
    if (isRetry && !lastRequestsRef.current[noteId]) return;
    const payload = buildNoteStatusRequest(item, targetStatus, draftRemarks[noteId],
      isRetry ? lastRequestsRef.current[noteId] : null);
    lastRequestsRef.current[noteId] = payload;
    pendingWritesRef.current.add(noteId);
    setBusyNotes((prev) => ({ ...prev, [noteId]: true }));
    setActionErrors((prev) => ({ ...prev, [noteId]: null }));

    try {
      const res = await api(`/api/v1/submit-notes/${encodeURIComponent(noteId)}/status`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (!isMountedRef.current) return;

      requireNoteStatusReceipt(res, noteId);
      {
        // Clear draft remarks for this note
        setDraftRemarks((prev) => {
          const next = { ...prev };
          delete next[noteId];
          return next;
        });
        setActionErrors((prev) => ({ ...prev, [noteId]: null }));
        // Refresh list to reflect latest counts and items
        await fetchNotesRef.current?.(true);
        if (isMountedRef.current && onNoteStatusChange) {
          // The write is confirmed even if the separate timeline refresh fails.
          Promise.resolve(onNoteStatusChange(res.note)).catch(() => {});
        }
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setActionErrors((prev) => ({
        ...prev,
        [noteId]: noteActionError(err, payload.status),
      }));
      // If revision conflict, refresh list immediately to display latest revision
      if (err.code === 'NOTE_REVISION_CONFLICT') {
        fetchNotesRef.current?.(true);
      }
    } finally {
      pendingWritesRef.current.delete(noteId);
      if (isMountedRef.current) {
        setBusyNotes((prev) => ({ ...prev, [noteId]: false }));
      }
    }
  }

  function handleTabClick(status) {
    if (status === statusFilter) return;
    setStatusFilter(status);
    setPage(0);
    setError(null);
    setItems([]);
  }

  return e('section', { className: 'submit-notes-inbox', 'aria-labelledby': 'submit-notes-inbox-title' },
    e('div', { className: 'inbox-header' },
      e('div', null,
        e('span', { className: 'timeline-overline' }, 'SUBMIT NOTES'),
        e('h3', { id: 'submit-notes-inbox-title' }, '工作说明收件箱'),
        e('p', null, '来自各分支与工作副本提交的工作进展与说明待办；复制只读，处理不改变代码。')
      )
    ),
    e('div', { className: 'inbox-filter-bar' },
      e(Tabs, {
        value: statusFilter,
        onValueChange: (value) => handleTabClick(String(value)),
        variant: 'pill',
        size: 'sm',
      },
        e(TabsList, { 'aria-label': '工作说明状态筛选' },
          STATUS_TABS.map((tab) => e(TabsTrigger, {
            key: tab.value,
            value: tab.value,
          }, `${tab.label} `, e('span', { className: 'tab-count' }, `(${counts[tab.value] ?? 0})`)))
        )
      )
    ),
    error && e(Alert, { variant: 'error', className: 'inbox-error-alert', role: 'alert' },
      e(AlertIcon),
      e('div', { className: 'notice-body' },
        e(AlertTitle, null, '读取工作说明失败'),
        e(AlertDescription, null, error.message || '网络连接或服务暂时不可用')
      ),
      e(Button, {
        variant: 'soft',
        size: 'sm',
        onClick: () => fetchNotes(false),
      }, '重新加载')
    ),
    e('div', { id: 'notes-panel', role: 'tabpanel', className: 'inbox-card-list' },
      loading && items.length === 0
        ? e('p', { className: 'inbox-empty' }, '正在加载工作说明…')
        : items.length === 0
          ? e('p', { className: 'inbox-empty' },
              statusFilter === 'pending'
                ? '当前没有待处理的工作说明。'
                : statusFilter === 'handled'
                  ? '当前没有已处理的工作说明。'
                  : '当前没有已归档的工作说明。'
            )
          : items.map((item) => e(SubmitNoteCard, {
              key: item.noteId,
              item,
              copied: copiedNotes[item.noteId] || false,
              busy: busyNotes[item.noteId] || false,
              actionError: actionErrors[item.noteId] || null,
              draftRemark: draftRemarks[item.noteId] !== undefined ? draftRemarks[item.noteId] : (item.handlingNote || ''),
              onDraftRemarkChange: (val) => setDraftRemarks((prev) => ({ ...prev, [item.noteId]: val })),
              onCopy: () => handleCopy(item),
              onStatusChange: (targetStatus) => handleStatusUpdate(item, targetStatus, false),
              onRetry: (targetStatus) => handleStatusUpdate(item, targetStatus, true),
            }))
    ),
    (total > PAGE_SIZE || page > 0) && e('footer', { className: 'inbox-pagination', 'aria-label': '工作说明分页' },
      e('span', { className: 'pagination-info' }, `第 ${page + 1} 页 / 共 ${total} 条说明`),
      e('div', { className: 'pagination-actions' },
        e(Button, {
          variant: 'soft',
          size: 'sm',
          disabled: page === 0 || loading,
          onClick: () => setPage((p) => Math.max(0, p - 1)),
        }, '上一页'),
        e(Button, {
          variant: 'soft',
          size: 'sm',
          disabled: !hasMore || loading,
          onClick: () => setPage((p) => p + 1),
        }, '下一页')
      )
    )
  );
}

function SubmitNoteCard({
  item,
  copied,
  busy,
  actionError,
  draftRemark,
  onDraftRemarkChange,
  onCopy,
  onStatusChange,
  onRetry,
}) {
  const source = item.source || {};
  const references = Array.isArray(item.references) ? item.references : [];

  let attributionText = '未归属会话';
  if (typeof source.attribution === 'object' && source.attribution?.agentId) {
    attributionText = `${source.attribution.agentId}${source.attribution.sessionId ? ` (会话: ${source.attribution.sessionId})` : ''}`;
  } else if (typeof source.attribution === 'string' && source.attribution !== 'unattributed') {
    attributionText = source.attribution;
  }

  return e('article', {
    className: `submit-note-card note-status-${item.status}`,
    'aria-label': item.title || '工作说明',
  },
    e('header', { className: 'note-card-header' },
      e('div', { className: 'note-card-title-group' },
        e(Badge, { variant: 'soft', size: 'sm', className: 'note-status-badge' }, noteStatusLabel(item.status)),
        e('h4', null, item.title || '无标题工作说明')
      ),
      e('time', { dateTime: item.createdAt, className: 'note-card-time' }, formatNoteTime(item.createdAt))
    ),
    e('div', { className: 'note-disclaimer', role: 'note' },
      '提示：说明与引用均为提交方原始资料，不构成平台背书或自动执行授权。'
    ),
    e('div', { className: 'note-body-box' },
      e('div', { className: 'note-body-text' }, renderSafeTextWithLinks(item.body))
    ),
    references.length > 0 && e('section', { className: 'note-references-section' },
      e('h5', null, `引用资料（${references.length}）`),
      e('ul', { className: 'note-references-list' },
        references.map((ref, idx) => e('li', { key: idx, className: 'note-reference-item' },
          e('span', { className: 'ref-type-tag' }, `[${ref.type || '引用'}]`),
          e('span', { className: 'ref-target' },
            /^https?:\/\//i.test(ref.target)
              ? e('a', {
                  href: ref.target,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className: 'safe-external-link',
                }, ref.title || ref.target)
              : e('span', null, ref.title ? `${ref.title} (${ref.target})` : ref.target)
          ),
          ref.commit && e('span', { className: 'ref-commit-chip' }, `commit: ${ref.commit.slice(0, 7)}`),
          ref.note && e('span', { className: 'ref-note-text' }, `— ${ref.note}`)
        ))
      )
    ),
    e('div', { className: 'note-source-section' },
      e('span', { className: 'source-label' }, '来源与归属：'),
      e('span', { className: 'source-item' }, source.projectName || '未知项目'),
      source.branch && e('span', { className: 'source-item source-branch' }, `分支: ${source.branch}`),
      e('span', { className: 'source-item source-attribution' }, `归属: ${attributionText}`)
    ),
    item.handlingNote && e('div', { className: 'note-handling-note-display' },
      e('strong', null, '处理备注：'),
      e('span', null, renderSafeTextWithLinks(item.handlingNote))
    ),
    e('div', { className: 'note-remark-input-group' },
      e('label', { htmlFor: `remark-input-${item.noteId}` },
        item.handlingNote ? '修改处理备注（可选）：' : '填写处理备注（可选）：'
      ),
      e(Textarea, {
        variant: 'soft',
        id: `remark-input-${item.noteId}`,
        rows: 2,
        disabled: busy,
        maxLength: 4000,
        value: draftRemark,
        placeholder: '可输入处理记录、审核决定或交接说明（最多 4000 字）…',
        onChange: (ev) => onDraftRemarkChange(ev.target.value),
      })
    ),
    actionError && e(Alert, { variant: 'error', className: 'note-action-error', role: 'alert' },
      e(AlertIcon),
      e('div', { className: 'notice-body' },
        e(AlertTitle, null, '操作提示'),
        e(AlertDescription, null, actionError.message),
        actionError.impact && e(AlertDescription, null, actionError.impact),
        actionError.required_action && e(AlertDescription, null, actionError.required_action)
      ),
      actionError.retryable && e(Button, {
        variant: 'soft',
        size: 'sm',
        onClick: () => onRetry(actionError.targetStatus),
        disabled: busy,
      }, busy ? '正在重试…' : '按原请求重试')
    ),
    e('footer', { className: 'note-card-actions' },
      e('div', { className: 'note-action-buttons' },
        e(Button, {
          variant: 'soft',
          size: 'sm',
          onClick: onCopy,
          title: '复制说明与处理指令，只读操作不改变状态',
        }, copied ? '已复制处理说明' : '复制说明'),
        item.status === 'pending' && [
          e(Button, {
            key: 'handle-btn',
            variant: 'primary',
            size: 'sm',
            disabled: busy || actionError?.retryable,
            onClick: () => onStatusChange('handled'),
          }, busy
            ? [e(Spinner, { key: 'spinner', variant: 'dots', currentColor: true, 'data-icon': 'start' }), '正在处理…']
            : '标记已处理'),
          e(Button, {
            key: 'archive-btn',
            variant: 'soft',
            size: 'sm',
            disabled: busy || actionError?.retryable,
            onClick: () => onStatusChange('archived'),
          }, busy ? '正在归档…' : '归档'),
        ],
        item.status === 'handled' && [
          e(Button, {
            key: 'restore-btn',
            variant: 'soft',
            size: 'sm',
            disabled: busy || actionError?.retryable,
            onClick: () => onStatusChange('pending'),
          }, busy ? '正在恢复…' : '恢复待处理'),
          e(Button, {
            key: 'archive-btn',
            variant: 'soft',
            size: 'sm',
            disabled: busy || actionError?.retryable,
            onClick: () => onStatusChange('archived'),
          }, busy ? '正在归档…' : '归档'),
        ],
        item.status === 'archived' && [
          e(Button, {
            key: 'restore-btn',
            variant: 'soft',
            size: 'sm',
            disabled: busy || actionError?.retryable,
            onClick: () => onStatusChange('pending'),
          }, busy ? '正在恢复…' : '恢复待处理'),
          e(Button, {
            key: 'handle-btn',
            variant: 'primary',
            size: 'sm',
            disabled: busy || actionError?.retryable,
            onClick: () => onStatusChange('handled'),
          }, busy ? '正在处理…' : '标记已处理'),
        ]
      ),
      e('details', { className: 'note-tech-details' },
        e('summary', null, '高级详情'),
        e('dl', { className: 'note-tech-dl' },
          e('div', null, e('dt', null, '说明编号'), e('dd', null, item.noteId)),
          e('div', null, e('dt', null, '版本 (Revision)'), e('dd', null, String(item.revision))),
          e('div', null, e('dt', null, '来源工作副本'), e('dd', null, source.canonicalPath || '未采集')),
          e('div', null, e('dt', null, '来源代码版本 (HEAD)'), e('dd', null, source.head || (source.headUnconfirmed ? '代码状态未确认' : '未采集'))),
          e('div', null, e('dt', null, '仓库身份'), e('dd', null, source.repositoryIdentity || '未采集')),
          e('div', null, e('dt', null, '副本身份'), e('dd', null, source.worktreeIdentity || '未采集')),
          e('div', null, e('dt', null, '更新时间'), e('dd', null, item.updatedAt)),
          item.handledAt && e('div', null, e('dt', null, '处理时间'), e('dd', null, item.handledAt)),
          item.archivedAt && e('div', null, e('dt', null, '归档时间'), e('dd', null, item.archivedAt))
        )
      )
    )
  );
}
