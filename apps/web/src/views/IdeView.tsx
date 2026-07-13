import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, Save, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { LoopDocument } from '@loop/contracts';
import type { LoopController } from '../useLoop';

export function IdeView({ controller, initialDocument }: { controller: LoopController; initialDocument?: LoopDocument }) {
  const [selectedId, setSelectedId] = useState(initialDocument?.id ?? controller.data.documents[0]?.id);
  const selected = controller.data.documents.find((doc) => doc.id === selectedId) ?? controller.data.documents[0];
  const [content, setContent] = useState(selected?.content ?? '');
  useEffect(() => { if (initialDocument) setSelectedId(initialDocument.id); }, [initialDocument]);
  useEffect(() => { setContent(selected?.content ?? ''); }, [selected?.id, selected?.content]);
  const dirty = selected ? content !== selected.content : false;
  const events = useMemo(() => [
    ...controller.data.tasks.slice(-4).map((task) => `[task] ${task.id}  ${task.status}  ${task.title}`),
    ...controller.data.approvals.slice(-3).map((approval) => `[approval] ${approval.status}  ${approval.tool}`)
  ], [controller.data.tasks, controller.data.approvals]);

  return (
    <main className="ide-view">
      <aside className="file-explorer">
        <div className="panel-heading"><span>资源管理器</span><ChevronDown size={15} /></div>
        <div className="tree-root"><Folder size={16} /><strong>{controller.data.currentProject?.name ?? 'project'}</strong></div>
        <div className="tree-folder"><span><ChevronDown size={14} /><Folder size={15} />docs</span>
          <div>{controller.data.documents.map((doc) => <button key={doc.id} className={doc.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(doc.id)}><FileText size={14} /><span>{doc.filename.replace('docs/', '')}</span><i className={doc.status} /></button>)}</div>
        </div>
        <div className="tree-folder collapsed"><span><ChevronRight size={14} /><Folder size={15} />apps</span></div>
        <div className="tree-folder collapsed"><span><ChevronRight size={14} /><Folder size={15} />packages</span></div>
      </aside>
      <section className="editor-region">
        <div className="editor-tabs"><div className="active"><FileCode2 size={14} />{selected?.filename.replace('docs/', '') ?? '未选择'}{dirty ? <i /> : null}</div><button className="icon-button" aria-label="保存文档" title="保存文档" disabled={!dirty || !selected || controller.working} onClick={() => selected && void controller.saveDocument(selected, content)}><Save size={16} /></button></div>
        <div className="editor-main"><div className="line-numbers" aria-hidden>{Array.from({ length: Math.max(30, content.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} aria-label="Markdown 编辑器" /></div>
        <div className="terminal-panel"><div className="terminal-head"><div><TerminalSquare size={15} /><strong>活动终端</strong></div><span>pwsh.exe · readonly</span></div><pre>{events.length ? events.join('\n') : 'Loop 事件流已连接。等待任务或审批事件…'}</pre></div>
      </section>
      <aside className="ide-inspector">
        <div className="panel-heading"><span>Agent / 任务</span><span>{controller.data.agents.length}</span></div>
        <div className="ide-agent-tree">{controller.data.agents.length ? controller.data.agents.map((agent) => <div key={agent.id} style={{ marginLeft: agent.depth * 14 }}><span className={`agent-status ${agent.status}`} /><div><strong>{agent.name}</strong><small>{agent.providerId} · ctx {Math.round(agent.contextUsage * 100)}%</small></div></div>) : <p>执行开始后，这里会显示 Agent 血统。</p>}</div>
        <div className="panel-heading task-heading"><span>任务依赖</span><span>{controller.data.tasks.length}</span></div>
        <div className="ide-task-list">{controller.data.tasks.map((task) => <div key={task.id}><span>{task.id}</span><strong>{task.title}</strong><small>{task.status}</small></div>)}</div>
      </aside>
    </main>
  );
}

