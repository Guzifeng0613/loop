import { Check, ChevronDown, FolderGit2, Plus, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LoopController } from '../useLoop';
import { AddProjectDialog } from './AddProjectDialog';

const stateLabels: Record<string, string> = {
  intake: '接收问题', clarifying: '深究中', doc_review: '待确认', ready: '可执行', decomposing: '拆分中',
  executing: '执行中', integrating: '集成中', verifying: '验证中', optimizing: '优化中', completed: '已完成',
  paused: '已暂停', failed: '失败', cancelled: '已取消'
};

export function ProjectSidebar({ controller, onNewRun }: { controller: LoopController; onNewRun: () => void }) {
  const { data } = controller;
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [projectMenuOpen]);

  return (
    <aside className="project-sidebar">
      <div className="sidebar-title-row">
        <div className="project-picker" ref={pickerRef}>
          <span className="section-label">当前项目</span>
          <button className="project-selector" aria-label="选择项目" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}>
            <FolderGit2 size={16} />
            <strong>{data.currentProject?.name ?? '未选择'}</strong>
            <ChevronDown size={15} />
          </button>
          {projectMenuOpen ? (
            <div className="project-menu" role="menu">
              <div className="project-menu-label">本机项目</div>
              {data.projects.map((project) => (
                <button key={project.id} role="menuitem" onClick={() => { setProjectMenuOpen(false); void controller.selectProject(project.id); }}>
                  <span className="project-menu-icon"><FolderGit2 size={15} /></span>
                  <span><strong>{project.name}</strong><small>{project.rootPath}</small></span>
                  {project.id === data.currentProject?.id ? <Check size={15} /> : null}
                </button>
              ))}
              <button className="project-menu-add" role="menuitem" onClick={() => { setProjectMenuOpen(false); setAddProjectOpen(true); }}><Plus size={15} />添加本地项目</button>
            </div>
          ) : null}
        </div>
        <button className="icon-button" aria-label="添加项目" title="添加项目" onClick={() => setAddProjectOpen(true)}><Plus size={17} /></button>
      </div>

      <div className={`git-gate ${data.currentProject?.isGit ? 'safe' : 'attention'}`}>
        {data.currentProject?.isGit ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
        <div>
          <strong>{data.currentProject?.isGit ? 'Git 隔离可用' : '执行门禁未满足'}</strong>
          <span>{data.currentProject?.isGit ? '任务将进入独立 worktree' : '可继续澄清；执行前需初始化 Git'}</span>
        </div>
      </div>

      <div className="sidebar-section-head">
        <span className="section-label">运行</span>
        <button className="icon-button mini" aria-label="新建运行" title="新建运行" onClick={onNewRun}><Plus size={14} /></button>
      </div>
      <div className="run-list">
        {data.runs.map((run) => (
          <button key={run.id} className={`run-row ${run.id === data.currentRun?.id ? 'active' : ''}`} onClick={() => void controller.selectRun(run.id)}>
            <span className={`status-dot status-${run.state}`} />
            <span className="run-copy">
              <strong>{run.title}</strong>
              <small>{stateLabels[run.state] ?? run.state} · {run.providerId}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="budget-mini">
          <span>Agent 并发容量</span>
          <strong>{data.settings.concurrency} / 16</strong>
        </div>
        <div className="budget-track"><i style={{ width: `${data.settings.concurrency / 16 * 100}%` }} /></div>
        <small className="sidebar-budget-note">单次运行上限 {data.settings.budget.maxCalls} 次调用</small>
      </div>
      {addProjectOpen ? <AddProjectDialog controller={controller} onClose={() => setAddProjectOpen(false)} /> : null}
    </aside>
  );
}
