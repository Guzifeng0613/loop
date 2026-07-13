import type { LoopDocument } from '@loop/contracts';
import type { LoopController } from '../useLoop';
import { ConversationPanel } from '../components/ConversationPanel';
import { Inspector } from '../components/Inspector';

export function WorkbenchView({ controller, onEditDocument }: { controller: LoopController; onEditDocument: (doc: LoopDocument) => void }) {
  return <div className="workbench-view"><ConversationPanel controller={controller} /><Inspector controller={controller} onEditDocument={onEditDocument} /></div>;
}

