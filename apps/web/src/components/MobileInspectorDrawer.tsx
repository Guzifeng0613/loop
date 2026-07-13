import { PanelRightClose } from 'lucide-react';
import type { LoopDocument } from '@loop/contracts';
import type { LoopController } from '../useLoop';
import { Inspector } from './Inspector';

export function MobileInspectorDrawer({ controller, onEditDocument, onClose }: { controller: LoopController; onEditDocument: (doc: LoopDocument) => void; onClose: () => void }) {
  return (
    <div className="mobile-drawer-backdrop right" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="mobile-drawer inspector-drawer" role="dialog" aria-modal="true" aria-label="运行检查器">
        <header><div><strong>运行检查器</strong><small>文档、任务、Agent 与审批</small></div><button className="icon-button" aria-label="关闭运行检查器" onClick={onClose}><PanelRightClose size={18} /></button></header>
        <Inspector controller={controller} onEditDocument={(doc) => { onClose(); onEditDocument(doc); }} />
      </aside>
    </div>
  );
}
