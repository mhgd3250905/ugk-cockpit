import React, { useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@appica/ui-react/dialog';

export function RemoveProjectAction({ project, api, disabled, onRemoved }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [request, setRequest] = useState(null);
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/remove`, {
        method: 'POST', body: JSON.stringify(request),
      });
      if (!result?.ok || !result.removed) throw new Error('尚未确认移除结果，请重试核对。');
      setOpen(false);
      await onRemoved();
    } catch (cause) {
      setError(cause.message || '暂时无法移除，请重试核对。');
    } finally { setBusy(false); }
  }
  return <>
    <Button variant="soft" size="sm" className="workspace-remove-button" disabled={disabled} onClick={() => {
      setError(null); setRequest({ commandId: crypto.randomUUID(), expectedRevision: project.archiveRevision ?? 0 }); setOpen(true);
    }}>从工作台移除</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent className="ugk-dialog" closeButton closeLabel="关闭">
        <DialogHeader><DialogTitle>从工作台移除「{project.name}」？</DialogTitle>
          <DialogDescription>项目将不再显示在工作台中，本地代码、文件和已有改动全部保留。</DialogDescription></DialogHeader>
        <DialogBody><p>工作历史保留。若只是暂时收起项目，可使用“归档项目”。</p>{error && <p role="alert">{error}</p>}</DialogBody>
        <DialogFooter><Button variant="soft" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={remove}>{busy ? '正在移除…' : error ? '重试核对' : '确认移除'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
