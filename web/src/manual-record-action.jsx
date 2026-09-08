import React, { useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@appica/ui-react/dialog';

export function ManualRecordAction({ project, workLine, api, onSaved, disabled }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const targetProject = open ? pending.project : project;
  const targetLine = open ? pending.workLine : workLine;
  const isWorkLine = Boolean(targetLine);
  const isEnded = isWorkLine ? targetLine.status === 'closed' : Boolean(targetProject.archivedAt);
  const label = isWorkLine ? (isEnded ? '重新打开工作线' : '手动结束工作线') : (isEnded ? '恢复项目' : '归档项目');
  const description = isWorkLine
    ? (isEnded ? '恢复这条工作线的未结束标记，并保留此前的工作记录。' : '在开发足迹中记录你已结束这条工作线。AI 会话和代码保持原状。')
    : (isEnded ? '项目会重新出现在默认项目列表中。' : '项目会移入已归档列表，项目代码、工作副本和历史记录全部保留。');

  async function save() {
    setSaving(true);
    setError(null);
    let saved = false;
    try {
      const suffix = isWorkLine ? `/work-lines/${encodeURIComponent(targetLine.worktreeId)}/state` : '/archive';
      await api(`/api/v1/projects/${encodeURIComponent(targetProject.id)}${suffix}`, {
        method: 'POST',
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedRevision: isWorkLine ? targetLine.revision : targetProject.archiveRevision,
          ...(isWorkLine ? { closed: !isEnded } : { archived: !isEnded }),
        }),
      });
      saved = true;
      setOpen(false);
      await onSaved();
    } catch (cause) {
      setError(saved ? '记录已保存，但页面刷新未完成，请刷新查看。' : (cause.message || '暂时无法保存，请刷新后重试。'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="soft" size="sm" disabled={disabled || saving} onClick={() => { setPending({ project, workLine }); setError(null); setOpen(true); }}>{label}</Button>
      {error && !open && <p role="alert">{error}</p>}
      <Dialog open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }} disablePointerDismissal>
        <DialogContent className="ugk-dialog" closeButton>
          <DialogHeader>
            <DialogTitle>{label} · {isWorkLine ? targetLine.label : targetProject.name}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p>{isWorkLine ? '这是一条用户操作记录，可以再次打开；本地副本是否删除由你另行决定。' : '之后可从“已归档项目”查看历史或恢复项目。'}</p>
            {error && <p role="alert">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="soft" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={save}>{saving ? '正在保存…' : `确认${label}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
