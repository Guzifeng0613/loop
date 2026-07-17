import { Activity, CircleStop, Download, Gauge, MoreHorizontal, PanelLeftOpen, Play, RotateCcw, ScrollText, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { LoopController } from '../useLoop';

const stateLabels: Record<string, string> = {
  intake: '接收问题', clarifying: '深究中', doc_review: '等待规范确认', ready: '可以执行', decomposing: '拆分任务',
  executing: 'Agent 执行中', integrating: '集成中', verifying: '验证中', optimizing: '优化中', awaiting_acceptance: '等待验收', completed: '已完成',
  paused: '已暂停', failed: '失败', cancelled: '已取消'
};

export function Topbar({ controller, onActivity, onProjectDrawer }: { controller: LoopController; onActivity: () => void; onProjectDrawer: () => void }) {
  const run = controller.data.currentRun;
  const running = run && ['decomposing', 'executing', 'integrating', 'verifying', 'optimizing'].includes(run.state);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  }, [menuOpen]);
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (!items.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      requestAnimationFrame(() => menuButtonRef.current?.focus());
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <header className="topbar">
      <div className="topbar-leading">
        <button className="icon-button mobile-only" aria-label="打开项目与运行" onClick={onProjectDrawer}><PanelLeftOpen size={18} /></button>
        <div className="topbar-context">
          <div className="topbar-breadcrumb"><span>{controller.data.currentProject?.name ?? '未选择项目'}</span><i />运行工作台</div>
          <div className="run-heading">
            <h1>{run?.title ?? '选择一个运行'}</h1>
            {run ? <span className={`state-label state-${run.state}`}>{stateLabels[run.state] ?? run.state}</span> : null}
          </div>
          <p>{run?.pauseReason ?? '文档、任务与 Agent 共享一个可恢复状态。'}</p>
        </div>
      </div>
      <div className="topbar-actions">
        <div className="model-summary"><ScrollText size={15} /><span>{run?.modelMode === 'auto' ? '智能路由' : run?.model ?? '未配置模型'}</span></div>
        <div className="usage-summary" title="当前运行预算"><Gauge size={15} /><span>{controller.data.usage.calls}/{controller.data.settings.budget.maxCalls}</span></div>
        <button className="button secondary compact activity-button" onClick={onActivity}><Activity size={16} />活动{controller.data.approvals.some((item) => item.status === 'pending') ? <i /> : null}</button>
        {running ? (
          <button className="button secondary compact" disabled={controller.working} onClick={() => void controller.runAction('pause')}><CircleStop size={16} />暂停</button>
        ) : run?.state === 'paused' ? (
          <button className="button primary compact" disabled={controller.working || run.blocker?.kind === 'approval'} title={run.blocker?.kind === 'approval' ? '请先处理待审批操作' : undefined} onClick={() => void controller.runAction('resume')}><Play size={16} />继续</button>
        ) : null}
        {run ? <div className="run-menu" ref={menuRef}><button ref={menuButtonRef} className="icon-button" aria-label="更多运行操作" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={18} /></button>{menuOpen ? <div className="run-menu-popover" role="menu" onKeyDown={onMenuKeyDown}><button role="menuitem" tabIndex={-1} onClick={() => { setMenuOpen(false); void controller.exportRun(); }}><Download size={15} />导出运行记录</button>{run.state === 'failed' ? <button role="menuitem" tabIndex={-1} onClick={() => { setMenuOpen(false); void controller.runAction('retry'); }}><RotateCcw size={15} />重试失败运行</button> : null}{!['completed', 'cancelled'].includes(run.state) ? <button className="danger" role="menuitem" tabIndex={-1} onClick={() => { setMenuOpen(false); if (window.confirm('确定取消当前运行吗？已写入的事件与文档不会删除。')) void controller.runAction('cancel'); }}><Trash2 size={15} />取消当前运行</button> : null}</div> : null}</div> : null}
      </div>
    </header>
  );
}
