import { PanelLeftClose, Workflow } from 'lucide-react';
import type { LoopController } from '../useLoop';
import { ProjectSidebar } from './ProjectSidebar';

export function MobileProjectDrawer({ controller, onNewRun, onClose }: { controller: LoopController; onNewRun: () => void; onClose: () => void }) {
  return (
    <div className="mobile-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="mobile-drawer" role="dialog" aria-modal="true" aria-label="项目与运行">
        <header><span><Workflow size={18} /></span><div><strong>项目与运行</strong><small>切换上下文或开始新的运行</small></div><button className="icon-button" aria-label="关闭项目与运行" onClick={onClose}><PanelLeftClose size={18} /></button></header>
        <ProjectSidebar controller={controller} onNewRun={onNewRun} />
      </aside>
    </div>
  );
}
