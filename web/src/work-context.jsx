import React, { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from '@appica/ui-react/dialog';
import './work-context.css';

function fileStatus(git) {
  if (git?.hasChanges === true) return '有本地改动';
  if (git?.hasChanges === false && git?.coherence === 'coherent') return '没有本地改动';
  return '尚未记录';
}

export function WorkContext({ context, label, formatTime, overview }) {
  const [open, setOpen] = useState(false);
  const titleRef = useRef(null);
  const triggerRef = useRef(null);
  const git = context?.git;
  const fields = [
    ['AI 工作会话', context?.currentAgent || '尚未记录'],
    ['会话状态', context?.session ? (context.session.active ? '接入或待接手' : '最近会话已结束') : '尚未记录'],
    ['工作目标', context?.currentGoal || '尚未记录'],
    ['当前工作线', git?.branch || '尚未记录'],
    ['最近提交', git?.head || '尚未记录'],
    ['本地文件', fileStatus(git)],
    ['最近检查', context?.lastObservedAt ? formatTime(context.lastObservedAt) : '尚未记录'],
  ];

  return (
    <>
      <button ref={triggerRef} type="button" className="work-context-summary" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`查看${label}的完整工作信息`}>
        <span className="work-context-label"><span className="work-context-name">{label}</span><span className="work-context-more">查看完整信息 ›</span></span>
        {overview && <span className="work-context-facts">{overview.lineCount} 条分支工作线 · {overview.closedCount} 条已手动结束</span>}
        <span className="work-context-goal"><strong>{overview ? '主项目工作' : '当前工作'}</strong>{context?.currentGoal || '尚未记录工作目标'}</span>
        <span className="work-context-facts">
          <span>{context?.currentAgent || '会话未记录'}</span>
          <span>{git?.branch || '工作线未记录'}</span>
          {git?.shortHead && <span>{git.shortHead}</span>}
          <span>{fileStatus(git)}</span>
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="ugk-dialog work-context-dialog" closeButton closeLabel="关闭" initialFocus={titleRef} finalFocus={triggerRef}>
          <DialogHeader>
            <DialogTitle ref={titleRef} tabIndex={-1}>{label} · 工作信息</DialogTitle>
            <DialogDescription>{overview ? '以下为主项目最近的工作与代码记录。查看分支信息，请选择对应工作线。' : '工作与代码状态来自这条工作线最近的记录。'}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <dl className="work-context-fields">
              {fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
            </dl>
            <p className="work-context-caption">代码状态为最近一次记录的结果，可能与当前本地文件不同。</p>
            <details className="work-context-technical">
              <summary>技术详情</summary>
              <dl className="work-context-fields">
                <div><dt>代码位置</dt><dd>{context?.path || '尚未记录'}</dd></div>
                {context?.sessionId && <div><dt>会话 ID</dt><dd>{context.sessionId}</dd></div>}
                {context?.revision != null && <div><dt>Revision</dt><dd>{context.revision}</dd></div>}
              </dl>
            </details>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
