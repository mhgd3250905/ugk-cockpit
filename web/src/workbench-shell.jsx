import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { projectAvatarUrl } from './avatar-color.mjs';
import './workbench-shell.css';

function ShellIcon({ name, ...props }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4 4" /></>,
    grid: <><rect x="3.5" y="3.5" width="6" height="6" rx="1.5" /><rect x="14.5" y="3.5" width="6" height="6" rx="1.5" /><rect x="3.5" y="14.5" width="6" height="6" rx="1.5" /><rect x="14.5" y="14.5" width="6" height="6" rx="1.5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M19.5 9a8 8 0 0 0-13-3L3.5 9m0-5v5h5M4.5 15a8 8 0 0 0 13 3l3-3m0 5v-5h-5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    back: <path d="m11 5-7 7 7 7M4 12h16" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    book: <><path d="M12 5v15M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

function ProjectAvatar({ project }) {
  const url = projectAvatarUrl(project);
  const [failedUrl, setFailedUrl] = useState(null);
  return (
    <span className="wb-project-avatar" aria-hidden="true">
      {url && failedUrl !== url
        ? <img src={url} alt="" onError={() => setFailedUrl(url)} />
        : <span>{Array.from(project.name?.trim() || '项目')[0].toLocaleUpperCase()}</span>}
    </span>
  );
}

export function WorkbenchShell({
  projects,
  activeProjectId,
  activeProjectName,
  onOpenProject,
  onOverview,
  onGuide,
  guideActive = false,
  onAddProject,
  busy,
  themeControl,
  isStale,
  refreshedAt,
  onRefresh,
  children,
}) {
  const [query, setQuery] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const contentRef = useRef(null);
  const previousProjectRef = useRef(activeProjectId);
  useEffect(() => {
    if (previousProjectRef.current === activeProjectId) return;
    previousProjectRef.current = activeProjectId;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const motion = contentRef.current?.animate(
      [{ opacity: 0.65, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    return () => motion?.cancel();
  }, [activeProjectId]);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProjects = projects.filter((project) => project.name.toLocaleLowerCase().includes(normalizedQuery));
  const lastRefresh = refreshedAt ? new Date(refreshedAt) : null;
  const refreshLabel = lastRefresh && Number.isFinite(lastRefresh.getTime())
    ? `最近同步 ${lastRefresh.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : '等待首次同步';

  function selectProject(project) {
    onOpenProject(project);
    setNavigationOpen(false);
  }

  function selectOverview() {
    onOverview();
    setNavigationOpen(false);
  }

  return (
    <div className={`wb-shell${navigationOpen ? ' wb-navigation-open' : ''}`}>
      <aside className="wb-sidebar" aria-label="工作台导航">
        <div className="wb-brand-row">
          <button className="wb-brand" type="button" onClick={selectOverview} aria-label="UGK Cockpit 项目总览">
            <span className="wb-brand-mark" aria-hidden="true">
              <img src="/assets/cockpit-mark.svg" width="38" height="38" alt="" />
            </span>
            <span className="wb-brand-copy"><strong>UGK <span>Cockpit</span></strong><small>你的项目，持续向前</small></span>
          </button>
          <button className="wb-nav-toggle" type="button" aria-label={navigationOpen ? '收起项目导航' : '展开项目导航'} aria-expanded={navigationOpen} aria-controls="wb-navigation" onClick={() => setNavigationOpen(!navigationOpen)}>
            <ShellIcon name="menu" />
          </button>
        </div>

        <div className="wb-navigation" id="wb-navigation">
          <button type="button" className={`wb-overview${!activeProjectId && !guideActive ? ' is-selected' : ''}`} aria-current={!activeProjectId && !guideActive ? 'page' : undefined} onClick={selectOverview}>
            <ShellIcon name="grid" /><span>项目总览</span><span className="wb-count">{projects.length}</span>
          </button>
          <button type="button" className={`wb-overview${guideActive ? ' is-selected' : ''}`} aria-current={guideActive ? 'page' : undefined} onClick={() => { onGuide(); setNavigationOpen(false); }}>
            <ShellIcon name="book" /><span>使用指南</span>
          </button>
          <div className="wb-project-section-label"><span>我的项目</span><button type="button" className="wb-icon-button" title="添加项目" aria-label="添加项目" onClick={onAddProject} disabled={busy}><ShellIcon name="plus" /></button></div>
          <label className="wb-search"><ShellIcon name="search" /><input type="search" placeholder="查找项目" aria-label="查找项目" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <nav className="wb-project-list" aria-label="项目">
            {visibleProjects.map((project) => (
              <button type="button" key={project.id} className={`wb-project-link${project.id === activeProjectId ? ' is-selected' : ''}`} aria-current={project.id === activeProjectId ? 'page' : undefined} title={project.name} onClick={() => selectProject(project)}>
                <ProjectAvatar project={project} /><span className="wb-project-name">{project.name}</span><ShellIcon name="chevron" className="wb-project-arrow" />
              </button>
            ))}
            {visibleProjects.length === 0 && <p className="wb-search-empty" role="status">{normalizedQuery ? '没有匹配的项目，试试其他名称。' : '添加第一个项目，开始记录工作。'}</p>}
          </nav>
          <div className="wb-sidebar-footer">
            <div className="wb-theme-control">{themeControl}</div>
            <div className="wb-service-state" title={isStale ? '暂未取得最新数据，当前显示上次同步结果。可点击顶部刷新重试。' : refreshLabel}>
              <span className={`wb-service-dot${isStale ? ' is-stale' : !refreshedAt ? ' is-pending' : ''}`} aria-hidden="true" />
              <div><span>{isStale ? '同步暂时中断' : refreshedAt ? '本地服务已同步' : '正在连接本地服务'}</span><small>{refreshLabel}</small></div>
            </div>
          </div>
        </div>
      </aside>

      <div className="wb-workspace">
        <header className="wb-topbar">
          <nav className="wb-breadcrumb" aria-label="页面位置">
            {(activeProjectId || guideActive) && <button type="button" className="wb-back" onClick={selectOverview} aria-label="返回项目总览" title="返回项目总览"><ShellIcon name="back" /></button>}
            <span className="wb-breadcrumb-parent">工作台</span><ShellIcon name="chevron" /><span className="wb-breadcrumb-current" title={guideActive ? '使用指南' : activeProject?.name || activeProjectName}>{guideActive ? '使用指南' : activeProject?.name || activeProjectName || '项目工作台'}</span>
          </nav>
          <div className="wb-topbar-actions">
            <button className="wb-icon-button wb-refresh" type="button" onClick={onRefresh} disabled={busy} title="刷新项目数据" aria-label="刷新项目数据"><ShellIcon name="refresh" /></button>
            <Button type="button" variant="soft" className="wb-add-project" onClick={onAddProject} disabled={busy}><ShellIcon name="plus" /><span>添加项目</span></Button>
          </div>
        </header>
        <div className="wb-content" ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}
