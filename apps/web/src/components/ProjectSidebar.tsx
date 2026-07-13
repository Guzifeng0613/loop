import { ChevronDown, FolderGit2, Plus, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { LoopController } from '../useLoop';

export function ProjectSidebar({ controller, onNewRun }: { controller: LoopController; onNewRun: () => void }) {
  const { data } = controller;
  return (
    <aside className="project-sidebar">
      <div className="sidebar-title-row">
        <div>
          <span className="section-label">当前项目</span>
          <button className="project-selector" aria-label="选择项目">
            <FolderGit2 size={16} />
            <strong>{data.currentProject?.name ?? '未选择'}</strong>
            <ChevronDown size={15} />
          </button>
        </div>
        <button className="icon-button" aria-label="添加项目" title="添加项目" onClick={() => {
          const root = window.prompt('输入本地项目的绝对路径');
          if (root) void controller.createProject(root);
        }}><Plus size={17} /></button>
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
              <small>{run.state} · {run.providerId}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="budget-mini">
          <span>Agent 并发</span>
          <strong>{data.settings.concurrency} / 16</strong>
        </div>
        <div className="budget-track"><i style={{ width: `${data.settings.concurrency / 16 * 100}%` }} /></div>
      </div>
    </aside>
  );
}
