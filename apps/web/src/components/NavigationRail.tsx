import { Code2, LayoutDashboard, ListChecks, Settings2 } from 'lucide-react';
import type { ViewMode } from '@loop/contracts';
import { LoopLogo } from './LoopLogo';

const views: { id: ViewMode; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'workbench', label: '工作台', icon: LayoutDashboard },
  { id: 'flow', label: '流程', icon: ListChecks },
  { id: 'ide', label: 'IDE', icon: Code2 }
];

export function NavigationRail({ view, onView, onSettings }: { view: ViewMode; onView: (view: ViewMode) => void; onSettings: () => void }) {
  return (
    <nav className="navigation-rail" aria-label="主导航">
      <div className="brand-mark" title="Loop"><LoopLogo compact /></div>
      <div className="rail-items">
        {views.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`rail-button ${view === id ? 'active' : ''}`} onClick={() => onView(id)} aria-label={label} title={label}>
            <Icon size={20} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <button className="rail-button rail-settings" onClick={onSettings} aria-label="设置" title="设置">
        <Settings2 size={20} strokeWidth={1.7} />
        <span>设置</span>
      </button>
    </nav>
  );
}
