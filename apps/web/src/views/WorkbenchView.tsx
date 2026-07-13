import type { LoopDocument } from '@loop/contracts';
import { useState } from 'react';
import type { LoopController } from '../useLoop';
import { ConversationPanel } from '../components/ConversationPanel';
import { Inspector } from '../components/Inspector';
import { MobileInspectorDrawer } from '../components/MobileInspectorDrawer';

export function WorkbenchView({ controller, onEditDocument }: { controller: LoopController; onEditDocument: (doc: LoopDocument) => void }) {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  return <div className="workbench-view"><ConversationPanel controller={controller} onOpenInspector={() => setInspectorOpen(true)} /><Inspector controller={controller} onEditDocument={onEditDocument} />{inspectorOpen ? <MobileInspectorDrawer controller={controller} onEditDocument={onEditDocument} onClose={() => setInspectorOpen(false)} /> : null}</div>;
}
