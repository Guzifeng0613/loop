import { Check, ChevronRight, Circle, FileCheck2, GitMerge, MessagesSquare, Network, TestTube2 } from 'lucide-react';
import type { RunState } from '@loop/contracts';
import type { LoopController } from '../useLoop';

const phases: { id: string; label: string; description: string; states: RunState[]; icon: typeof Circle }[] = [
  { id: 'understand', label: '理解', description: '区分事实、假设与未决问题', states: ['intake', 'clarifying'], icon: MessagesSquare },
  { id: 'spec', label: '规范', description: '冻结 Markdown 与版本哈希', states: ['doc_review', 'ready'], icon: FileCheck2 },
  { id: 'plan', label: '计划', description: '建立任务依赖与 Agent 血统', states: ['decomposing'], icon: Network },
  { id: 'execute', label: '执行', description: '隔离 worktree 并验证子任务', states: ['executing', 'integrating'], icon: GitMerge },
  { id: 'verify', label: '验收', description: '全局测试、优化与最终报告', states: ['verifying', 'optimizing', 'completed'], icon: TestTube2 }
];

export function FlowView({ controller }: { controller: LoopController }) {
  const { data } = controller;
  const state = data.currentRun?.state ?? 'intake';
  const activeIndex = Math.max(0, phases.findIndex((phase) => phase.states.includes(state)));
  const current = phases[activeIndex] ?? phases[0]!;
  return (
    <main className="flow-view">
      <header className="flow-hero"><div><h2>从问题到可验证结果</h2><p>每一步都有文档门禁、负责人和退出条件。</p></div><span>{activeIndex + 1} / {phases.length}</span></header>
      <div className="flow-layout">
        <ol className="phase-list">
          {phases.map((phase, index) => {
            const Icon = phase.icon;
            const completed = index < activeIndex || state === 'completed';
            const active = index === activeIndex && state !== 'completed';
            return <li key={phase.id} className={`${active ? 'active' : ''} ${completed ? 'completed' : ''}`}><div className="phase-line"><span>{completed ? <Check size={16} /> : <Icon size={16} />}</span>{index < phases.length - 1 ? <i /> : null}</div><div><strong>{phase.label}</strong><p>{phase.description}</p></div>{active ? <ChevronRight size={17} /> : null}</li>;
          })}
        </ol>
        <section className="phase-detail">
          <div className="phase-detail-head"><span className="phase-index">0{activeIndex + 1}</span><div><span>当前阶段</span><h3>{current.label}</h3></div></div>
          <div className="quality-gate"><div><strong>质量门槛</strong><span>{state === 'doc_review' ? '五份核心文档已读取，等待批准' : state === 'ready' ? '规范哈希已冻结，可以拆分任务' : current.description}</span></div><span className={`large-state state-${state}`}>{state}</span></div>
          <div className="flow-metrics">
            <Metric label="文档" value={`${data.documents.filter((doc) => doc.status === 'approved').length}/${data.documents.length}`} note="已批准" />
            <Metric label="任务" value={`${data.tasks.filter((task) => task.status === 'completed').length}/${data.tasks.length || 0}`} note="已完成" />
            <Metric label="Agent" value={`${data.agents.filter((agent) => agent.status === 'running').length}`} note="运行中" />
          </div>
          <div className="phase-actions">
            {state === 'doc_review' ? <button className="button primary" onClick={() => void controller.approveDocs()} disabled={controller.working}><Check size={17} />批准规范并继续</button> : null}
            {state === 'ready' ? <button className="button primary" onClick={() => void controller.execute()} disabled={controller.working || !data.currentProject?.isGit}><GitMerge size={17} />拆分并执行</button> : null}
            {!data.currentProject?.isGit ? <button className="button secondary" onClick={() => void controller.initializeGit()}>初始化 Git</button> : null}
          </div>
          {data.currentRun?.pauseReason ? <div className="pause-callout"><strong>当前暂停原因</strong><p>{data.currentRun.pauseReason}</p></div> : null}
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="flow-metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

