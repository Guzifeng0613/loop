import { Check, ChevronRight, FileText, GitPullRequestArrow, Network, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { LoopDocument } from '@loop/contracts';
import type { LoopController } from '../useLoop';

type InspectorTab = 'docs' | 'tasks' | 'agents' | 'approvals';

export function Inspector({ controller, onEditDocument }: { controller: LoopController; onEditDocument: (doc: LoopDocument) => void }) {
  const [tab, setTab] = useState<InspectorTab>('docs');
  const { data } = controller;
  const tabs: { id: InspectorTab; label: string; count: number }[] = [
    { id: 'docs', label: '文档', count: data.documents.length },
    { id: 'tasks', label: '任务', count: data.tasks.length },
    { id: 'agents', label: 'Agent', count: data.agents.length },
    { id: 'approvals', label: '审批', count: data.approvals.filter((item) => item.status === 'pending').length }
  ];
  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}<span>{item.count}</span></button>)}
      </div>
      <div className="inspector-content">
        {tab === 'docs' ? (
          <>
            <div className="inspector-intro"><div><span>当前门禁</span><strong>规范文档</strong><small>{data.currentRun?.docsApproved ? '版本与哈希已冻结' : '变更会使任务引用失效'}</small></div><span className={`gate-icon ${data.currentRun?.docsApproved ? 'approved' : ''}`}>{data.currentRun?.docsApproved ? <Check size={15} /> : <ShieldAlert size={15} />}</span></div>
            <div className="document-list">
              {data.documents.map((doc) => (
                <button key={doc.id} className="document-row" onClick={() => onEditDocument(doc)}>
                  <FileText size={17} />
                  <span><strong>{doc.title}</strong><small>{doc.filename} · v{doc.version}</small></span>
                  <span className={`doc-status ${doc.status}`}>{doc.status}</span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
            {!data.currentRun?.docsApproved ? <button className="button primary full" disabled={controller.working} onClick={() => void controller.approveDocs()}><Check size={16} />批准全部规范</button> : (
              <button className="button primary full" disabled={controller.working || !data.currentProject?.isGit || data.currentRun.state !== 'ready'} onClick={() => void controller.execute()}><GitPullRequestArrow size={16} />拆分并执行</button>
            )}
            {!data.currentProject?.isGit ? <button className="text-action" onClick={() => void controller.initializeGit()}>初始化 Git 以解除执行门禁</button> : null}
          </>
        ) : null}

        {tab === 'tasks' ? <div className="task-list">{data.tasks.length ? data.tasks.map((task) => (
          <div className="task-row" key={task.id}><span className={`task-state ${task.status}`} /><div><strong>{task.title}</strong><small>{task.id} · {task.status}</small></div><span>{task.depth}</span></div>
        )) : <EmptyState icon={GitPullRequestArrow} title="尚未拆分任务" body="批准规范后，Lead Main 会建立依赖图。" />}</div> : null}

        {tab === 'agents' ? <div className="agent-list">{data.agents.length ? data.agents.map((agent) => (
          <div className="agent-row" key={agent.id} style={{ paddingLeft: 12 + agent.depth * 14 }}><Network size={16} /><div><strong>{agent.name}</strong><small>{agent.role} · {agent.providerId} · {Math.round(agent.contextUsage * 100)}%</small></div><span className={`agent-status ${agent.status}`} /></div>
        )) : <EmptyState icon={Network} title="Agent 池为空" body="任务拆分完成后会显示血统、模型与上下文。" />}</div> : null}

        {tab === 'approvals' ? <div className="approval-list">{data.approvals.length ? data.approvals.map((approval) => (
          <div className={`approval-card ${approval.status}`} key={approval.id}><div><ShieldAlert size={17} /><span><strong>{approval.tool}</strong><small>{approval.summary}</small></span></div><p>{approval.policyReason}</p>{approval.status === 'pending' ? <div className="approval-actions"><button onClick={() => void controller.resolveApproval(approval.id, 'rejected')}>拒绝</button><button className="approve" onClick={() => void controller.resolveApproval(approval.id, 'approved')}>批准一次</button></div> : <span className="resolved">{approval.status}</span>}</div>
        )) : <EmptyState icon={ShieldAlert} title="没有待审批操作" body="高风险命令、安装和最终合并会出现在这里。" />}</div> : null}
      </div>
    </aside>
  );
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Network; title: string; body: string }) {
  return <div className="empty-state"><Icon size={24} /><strong>{title}</strong><p>{body}</p></div>;
}
