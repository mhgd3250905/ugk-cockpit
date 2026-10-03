import React, { forwardRef, useId, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@appica/ui-react/dialog';
import './work-context.css';
import { WorkbenchIcon } from './icons.jsx';
import { AgentPlatformBadge } from './agent-platform-badge.jsx';

function fileStatus(git) {
  if (git?.available === false) return '未采集版本状态';
  if (git?.hasChanges === true) return '有本地改动';
  if (git?.hasChanges === false && git?.coherence === 'coherent') return '没有本地改动';
  return '尚未记录';
}

const workContextTabs = [
  { id: 'overview', label: '工作概况' },
  { id: 'sessions', label: '会话与接手' },
  { id: 'code', label: '代码记录' },
];

export const WorkContext = forwardRef(function WorkContext({ context, label, projectName, formatTime, overview, closed, operations }, ref) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const titleRef = useRef(null);
  const triggerRef = useRef(null);
  const returnFocusRef = useRef(null);
  const bodyRef = useRef(null);
  const tabRefs = useRef({});
  const id = useId();
  const git = context?.git;
  const scope = overview || context?.laneKey === 'main' ? '主项目' : label;
  const observedAt = context?.lastObservedAt ? formatTime(context.lastObservedAt) : '尚未记录';
  const sessionStatus = context?.session ? (context.session.active ? '接入或待接手' : '最近会话已结束') : '尚未记录';

  function selectTab(nextTab, focus = false) {
    setActiveTab(nextTab);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    if (focus) tabRefs.current[nextTab]?.focus();
  }

  function openTab(nextTab, triggerElement) {
    returnFocusRef.current = triggerElement || triggerRef.current;
    selectTab(nextTab);
    setOpen(true);
  }

  useImperativeHandle(ref, () => ({
    openSessions(triggerElement) { openTab('sessions', triggerElement); },
  }));

  function onTabKeyDown(event, currentTab) {
    const index = workContextTabs.findIndex((tab) => tab.id === currentTab);
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % workContextTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + workContextTabs.length) % workContextTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = workContextTabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(workContextTabs[nextIndex].id, true);
  }

  return (
    <>
      <button ref={triggerRef} type="button" className="work-context-summary" onClick={(event) => openTab('overview', event.currentTarget)} aria-haspopup="dialog" aria-label={`查看${label}的完整工作信息`}>
        <span className="work-context-label"><span className="work-context-name">{closed ? '最后工作 · 已结束' : '当前工作'}</span><span className="work-context-more">查看完整信息<WorkbenchIcon name="chevron" size={16} /></span></span>
        <span className="work-context-goal">{context?.currentGoal || '尚未记录工作目标'}</span>
        <span className="work-context-facts">
          {context?.currentAgent && <AgentPlatformBadge agent={context.currentAgent} />}
          <span>{scope}</span>
          <span>{git?.branch || '工作线未记录'}</span>
          {git?.shortHead && <span>{git.shortHead}</span>}
          <span>{fileStatus(git)}</span>
          {overview && <span>{overview.lineCount} 条分支工作线 · {overview.closedCount} 条已手动结束</span>}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="ugk-dialog work-context-dialog" closeButton closeLabel="关闭工作信息" initialFocus={titleRef} finalFocus={returnFocusRef}>
          <DialogHeader>
            <DialogTitle ref={titleRef} tabIndex={-1}>工作信息</DialogTitle>
            <DialogDescription>{scope}{projectName ? ` · ${projectName}` : ''}</DialogDescription>
          </DialogHeader>
          <div className="work-context-tabs" role="tablist" aria-label="工作信息分类">
            {workContextTabs.map((tab) => (
              <button key={tab.id} ref={(element) => { tabRefs.current[tab.id] = element; }} type="button" role="tab" id={`${id}-tab-${tab.id}`} aria-controls={`${id}-panel-${tab.id}`} aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => selectTab(tab.id)} onKeyDown={(event) => onTabKeyDown(event, tab.id)}>{tab.label}</button>
            ))}
          </div>
          <DialogBody ref={bodyRef}>
            <section className="work-context-panel" role="tabpanel" id={`${id}-panel-overview`} aria-labelledby={`${id}-tab-overview`} hidden={activeTab !== 'overview'} tabIndex={0}>
              <div className="work-context-section-heading"><h3>{closed ? '最后工作 · 已结束' : '当前工作'}</h3>{context?.currentAgent && <AgentPlatformBadge agent={context.currentAgent} />}</div>
              <p className="work-context-full-goal">{context?.currentGoal || '尚未记录工作目标'}</p>
              <dl className="work-context-fields">
                <div><dt>工作范围</dt><dd>{scope}{git?.branch ? ` · ${git.branch}` : ''}</dd></div>
                <div><dt>最近记录</dt><dd>{observedAt}</dd></div>
                <div><dt>最近记录的会话状态</dt><dd>{sessionStatus}</dd></div>
                {overview && <div><dt>分支工作线</dt><dd>{overview.lineCount} 条 · {overview.closedCount} 条已手动结束</dd></div>}
              </dl>
              <div className="work-context-overview-links">
                <button type="button" onClick={() => selectTab('sessions', true)}>查看会话与接手<WorkbenchIcon name="chevron" size={16} /></button>
                <button type="button" onClick={() => selectTab('code', true)}>查看代码记录<WorkbenchIcon name="chevron" size={16} /></button>
              </div>
            </section>
            <section className="work-context-panel" role="tabpanel" id={`${id}-panel-sessions`} aria-labelledby={`${id}-tab-sessions`} hidden={activeTab !== 'sessions'} tabIndex={0}>
              {open && operations}
            </section>
            <section className="work-context-panel" role="tabpanel" id={`${id}-panel-code`} aria-labelledby={`${id}-tab-code`} hidden={activeTab !== 'code'} tabIndex={0}>
              <div className="work-context-section-heading"><h3>最近代码记录</h3></div>
              <dl className="work-context-fields">
                <div><dt>当前工作线</dt><dd>{git?.branch || '尚未记录'}</dd></div>
                <div><dt>最近提交</dt><dd>{git?.shortHead || git?.head || '尚未记录'}</dd></div>
                <div><dt>本地文件</dt><dd>{fileStatus(git)}</dd></div>
                <div><dt>最近检查</dt><dd>{observedAt}</dd></div>
              </dl>
              <p className="work-context-caption">代码状态为最近一次记录的结果，可能与当前本地文件不同。</p>
              <details className="work-context-technical">
                <summary>完整提交与记录来源</summary>
                <p className="work-context-caption">以下标识关联这份代码记录，可能与“会话与接手”中的当前可操作会话不同。</p>
                <dl className="work-context-fields">
                  <div><dt>完整提交</dt><dd>{git?.head || '尚未记录'}</dd></div>
                  <div><dt>代码位置</dt><dd>{context?.path || '尚未记录'}</dd></div>
                  {context?.sessionId && <div><dt>记录关联会话 ID</dt><dd>{context.sessionId}</dd></div>}
                  {context?.revision != null && <div><dt>记录 Revision</dt><dd>{context.revision}</dd></div>}
                </dl>
              </details>
            </section>
          </DialogBody>
          <DialogFooter className="work-context-footer">
            <p>会话接入不代表 AI 正在运行。</p>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
