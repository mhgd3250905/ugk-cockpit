import React, { useEffect, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@appica/ui-react/dialog';
import './service-status.css';

function duration(seconds) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function ServiceStatus({ api }) {
  const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
  const [info, setInfo] = useState(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api || requested) return;
    let alive = true;
    let timer;
    async function poll() {
      try {
        const result = await api('/api/v1/service/status');
        if (!result?.ok || !result.version || !Number.isFinite(result.uptimeSeconds)) throw new Error('服务信息未确认');
        if (alive) { setInfo(result); setOffline(false); }
      } catch { if (alive) setOffline(true); }
      finally { if (alive) timer = setTimeout(poll, 15000); }
    }
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, requested]);
  async function shutdown() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api('/api/v1/service/shutdown', { method: 'POST', body: JSON.stringify({ userConfirmed: true }) });
      if (!result?.ok || result.status !== 'stopping') throw new Error('关闭结果尚未确认，请检查服务状态。');
      setRequested(true); setOpen(false);
    } catch (cause) { setError(cause.message || '关闭结果尚未确认，请检查服务状态。'); }
    finally { setBusy(false); }
  }
  return <>
    <div className={`service-status-strip${offline || requested ? ' is-offline' : ''}`} aria-label="本地服务运行信息">
      <span className="service-status-indicator" aria-hidden="true" />
      <span role="status">{requested ? '已请求关闭服务' : offline ? '服务未连接' : info ? '服务运行中' : '正在连接服务'}</span>
      {info && !requested && <><span className="service-status-version">v{info.version}</span><span className="service-status-port">端口 {port}</span><span className="service-status-uptime" title={`启动于 ${new Date(info.startedAt).toLocaleString('zh-CN')}`}>已运行 {duration(info.uptimeSeconds)}</span></>}
      {requested ? <span className="service-status-restart">再次使用时打开 Cockpit 启动器</span> : <button type="button" className="service-shutdown-button" disabled={!info || offline || busy} onClick={() => { setError(''); setOpen(true); }}>关闭服务</button>}
    </div>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="ugk-dialog" closeButton closeLabel="关闭确认窗口">
        <DialogHeader><DialogTitle>关闭本地 Cockpit 服务？</DialogTitle><DialogDescription>工作台和 AI 连接将暂时不可用。</DialogDescription></DialogHeader>
        <DialogBody><p>服务会等待正在处理的请求结束后关闭。项目代码、历史记录和工作会话会保留，不会自动结束 AI 任务。</p><p>再次使用时，打开 Cockpit 启动器即可。</p>{error && <p role="alert">{error}</p>}</DialogBody>
        <DialogFooter><Button variant="soft" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button variant="primary" disabled={busy} onClick={shutdown}>{busy ? '正在请求关闭…' : '确认关闭服务'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
