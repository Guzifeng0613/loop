import { AlertTriangle, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import type { LoopDocument } from '@loop/contracts';
import { NavigationRail } from './components/NavigationRail';
import { ProjectSidebar } from './components/ProjectSidebar';
import { Topbar } from './components/Topbar';
import { SettingsPanel } from './components/SettingsPanel';
import { ActivityDrawer } from './components/ActivityDrawer';
import { NewRunPanel } from './components/NewRunPanel';
import { WorkbenchView } from './views/WorkbenchView';
import { FlowView } from './views/FlowView';
import { IdeView } from './views/IdeView';
import { useLoop } from './useLoop';
import { LoopLogo } from './components/LoopLogo';
import { MobileProjectDrawer } from './components/MobileProjectDrawer';

export function App() {
  const controller = useLoop();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [initialIdeDoc, setInitialIdeDoc] = useState<LoopDocument>();

  const editDocument = (document: LoopDocument) => {
    setInitialIdeDoc(document);
    controller.setView('ide');
  };

  if (controller.loading) return <div className="app-loading"><div className="brand-mark"><LoopLogo compact /></div><LoaderCircle className="spin loading-spinner" size={18} /><strong>正在恢复 Loop 状态…</strong><span>读取项目、文档哈希与事件水位</span></div>;

  return (
    <div className="app-shell">
      <NavigationRail view={controller.view} onView={controller.setView} onSettings={() => setSettingsOpen(true)} />
      <ProjectSidebar controller={controller} onNewRun={() => setNewRunOpen(true)} />
      <div className="main-shell">
        <Topbar controller={controller} onActivity={() => setActivityOpen((current) => !current)} onProjectDrawer={() => setProjectDrawerOpen(true)} />
        <div className="view-region">
          {controller.view === 'workbench' ? <WorkbenchView controller={controller} onEditDocument={editDocument} /> : null}
          {controller.view === 'flow' ? <FlowView controller={controller} /> : null}
          {controller.view === 'ide' ? <IdeView controller={controller} {...(initialIdeDoc ? { initialDocument: initialIdeDoc } : {})} /> : null}
        </div>
      </div>
      {settingsOpen ? <SettingsPanel controller={controller} onClose={() => setSettingsOpen(false)} /> : null}
      {activityOpen ? <ActivityDrawer controller={controller} onClose={() => setActivityOpen(false)} /> : null}
      {newRunOpen ? <NewRunPanel controller={controller} onClose={() => setNewRunOpen(false)} /> : null}
      {projectDrawerOpen ? <MobileProjectDrawer controller={controller} onClose={() => setProjectDrawerOpen(false)} onNewRun={() => { setProjectDrawerOpen(false); setNewRunOpen(true); }} /> : null}
      {controller.error ? <div className="error-toast" role="alert"><AlertTriangle size={18} /><div><strong>操作未完成</strong><span>{controller.error}</span></div><button aria-label="关闭错误" onClick={controller.dismissError}><X size={16} /></button></div> : null}
    </div>
  );
}
