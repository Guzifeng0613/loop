import { AlertTriangle, Check, ChevronRight, Circle, FileCheck2, FolderPlus, GitMerge, MessagesSquare, Network, RotateCcw, TestTube2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RunRecoveryDecision, RunState } from '@loop/contracts';
import type { LoopController } from '../useLoop';

const phases: { id: string; label: string; description: string; states: RunState[]; icon: typeof Circle }[] = [
  { id: 'understand', label: '理解', description: '区分事实、假设与未决问题', states: ['intake', 'clarifying'], icon: MessagesSquare },
  { id: 'spec', label: '规范', description: '冻结 Markdown 与版本哈希', states: ['doc_review', 'ready'], icon: FileCheck2 },
  { id: 'plan', label: '计划', description: '建立任务依赖与 Agent 血统', states: ['decomposing'], icon: Network },
  { id: 'execute', label: '执行', description: '隔离 worktree 并验证子任务', states: ['executing', 'integrating'], icon: GitMerge },
  { id: 'verify', label: '验收', description: '全局测试、交付摘要与用户确认', states: ['verifying', 'optimizing', 'awaiting_acceptance', 'completed'], icon: TestTube2 }
];

export function FlowView({ controller }: { controller: LoopController }) {
  const { data } = controller;
  const run = data.currentRun;
  const state = run?.state ?? 'intake';
  const interrupted = ['paused', 'failed', 'cancelled'].includes(state);
  const phaseState = interrupted && run?.previousState ? run.previousState : state;
  const locatedIndex = phases.findIndex((phase) => phase.states.includes(phaseState));
  const activeIndex = locatedIndex >= 0 ? locatedIndex : 0;
  const [selectedIndex, setSelectedIndex] = useState(activeIndex);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    setSelectedIndex(activeIndex);
    setFeedback('');
  }, [activeIndex, run?.id]);
  if (!run) {
    return <main className="flow-view flow-onboarding"><div><FolderPlus size={28} /><h2>先建立一个运行</h2><p>{data.currentProject ? '从左侧项目栏新建运行，Loop 会先澄清问题再进入规范门禁。' : '先添加一个本地 Git Web 项目，再创建第一个运行。'}</p></div></main>;
  }
  const current = phases[selectedIndex] ?? phases[0]!;
  const viewingCurrent = selectedIndex === activeIndex;
  const deliveryStatus = controller.deliveryStatus ?? (controller.delivery?.runId === run.id ? 'ready' : 'loading');
  const deliveryReady = deliveryStatus === 'ready' && controller.delivery?.runId === run.id;
  const acceptanceDisabled = controller.working || !deliveryReady;
  const projectCheck = controller.projectCheck;
  const executionBlocked = state === 'ready' && projectCheck?.status === 'ready' && (!projectCheck.data?.isGit || !projectCheck.data.clean);
  return (
    <main className="flow-view">
      <header className="flow-hero"><div><h2>从问题到可验证结果</h2><p>每一步都有文档门禁、负责人和退出条件。</p></div><span>当前阶段 {activeIndex + 1} / {phases.length}</span></header>
      <div className="flow-layout">
        <ol className="phase-list">
          {phases.map((phase, index) => {
            const Icon = phase.icon;
            const completed = index < activeIndex || state === 'completed';
            const active = index === activeIndex && state !== 'completed';
            const accessible = index <= activeIndex || state === 'completed';
            return <li key={phase.id} className={`${active ? 'active' : ''} ${completed ? 'completed' : ''} ${selectedIndex === index ? 'selected' : ''}`}><button disabled={!accessible} onClick={() => setSelectedIndex(index)} aria-current={selectedIndex === index ? 'step' : undefined}><div className="phase-line"><span>{completed ? <Check size={16} /> : <Icon size={16} />}</span>{index < phases.length - 1 ? <i /> : null}</div><div><strong>{phase.label}</strong><p>{phase.description}</p></div>{active ? <ChevronRight size={17} /> : null}</button></li>;
          })}
        </ol>
        <section className="phase-detail">
          <div className="phase-detail-head"><span className="phase-index">0{activeIndex + 1}</span><div><span>当前阶段</span><h3>{current.label}</h3></div></div>
          <div className="quality-gate"><div><strong>{viewingCurrent ? '当前质量门槛' : '阶段目标'}</strong><span>{viewingCurrent && state === 'doc_review' ? '五份核心文档已读取，等待批准' : viewingCurrent && state === 'ready' ? '规范哈希已冻结，可以拆分任务' : viewingCurrent && state === 'awaiting_acceptance' ? '验证已经通过，等待你决定保留、合并、修改或放弃' : current.description}</span></div>{viewingCurrent ? <span className={`large-state state-${state}`}>{interrupted ? `${state} · ${phaseState}` : state}</span> : <span className="large-state history">已回看</span>}</div>
          <div className="flow-metrics">
            <Metric label="文档" value={`${data.documents.filter((doc) => doc.status === 'approved').length}/${data.documents.length}`} note="已批准" />
            <Metric label="任务" value={`${data.tasks.filter((task) => task.status === 'completed').length}/${data.tasks.length || 0}`} note="已完成" />
            <Metric label="Agent" value={`${data.agents.filter((agent) => agent.status === 'running').length}`} note="运行中" />
          </div>
          {viewingCurrent && state === 'awaiting_acceptance' ? <section className="delivery-card" aria-busy={deliveryStatus === 'loading'}>
            <header><div><strong>交付摘要</strong><span>{deliveryReady ? controller.delivery?.integrationBranch ?? '保留在已验证分支' : deliveryStatus === 'error' ? '交付摘要读取失败' : '正在读取集成分支…'}</span></div><b>{deliveryReady ? `$ ${controller.delivery!.actualCost.toFixed(4)}` : '—'}</b></header>
            {deliveryStatus === 'loading' ? <div className="pause-callout" role="status"><strong>正在核对交付摘要</strong><p>摘要与当前运行匹配后，验收操作才会解锁。</p></div> : null}
            {deliveryStatus === 'error' ? <div className="delivery-warning" role="alert"><strong>无法读取交付摘要</strong><span>{controller.deliveryError ?? '请等待连接恢复或重新选择该运行。'}</span></div> : null}
            {deliveryReady ? <>
              <div className="delivery-grid"><div><strong>变更文件</strong><ul>{controller.delivery!.filesChanged.length ? controller.delivery!.filesChanged.map((file) => <li key={file}>{file}</li>) : <li>暂无文件变更</li>}</ul></div><div><strong>验证命令</strong><ul>{controller.delivery!.verificationCommands.length ? controller.delivery!.verificationCommands.map((command, index) => <li key={`${command}-${index}`}>{command}</li>) : <li>未声明验证命令</li>}</ul></div></div>
              <div className="delivery-grid"><div><strong>提交</strong><ul>{controller.delivery!.commits.length ? controller.delivery!.commits.map((commit) => <li key={commit}>{commit}</li>) : <li>没有独立任务提交</li>}</ul></div><div><strong>任务结果</strong><ul>{controller.delivery!.taskResults.length ? controller.delivery!.taskResults.map((result) => <li key={result.id}>{result.verified ? '已验证' : '未验证'} · {result.summary}</li>) : <li>没有结构化任务结果</li>}</ul></div></div>
              {controller.delivery!.risks.length ? <div className="delivery-warning"><strong>风险</strong><span>{controller.delivery!.risks.join('；')}</span></div> : null}
              {controller.delivery!.unresolved.length ? <div className="delivery-warning"><strong>未解决事项</strong><span>{controller.delivery!.unresolved.join('；')}</span></div> : null}
            </> : null}
            <label><span>要求修改时的反馈</span><textarea value={feedback} disabled={!deliveryReady || controller.working} onChange={(event) => setFeedback(event.target.value)} rows={3} placeholder="说明需要修改的行为或验收标准。" /></label>
            <div className="delivery-actions"><button className="button secondary" disabled={acceptanceDisabled} onClick={() => { if (window.confirm('确认放弃这次交付结果？集成 worktree 会进入保留期，运行将标记为已取消。')) void controller.acceptDelivery('discard'); }}>放弃结果</button><button className="button secondary" disabled={acceptanceDisabled || !feedback.trim()} onClick={() => void controller.acceptDelivery('request_changes', feedback)}>要求修改</button><button className="button secondary" disabled={acceptanceDisabled} onClick={() => void controller.acceptDelivery('accept_keep_branch')}>验收并保留分支</button><button className="button primary" disabled={acceptanceDisabled} onClick={() => { if (window.confirm('确认把已验证的集成分支合并到当前项目分支？')) void controller.acceptDelivery('accept_merge'); }}>验收并合并</button></div>
          </section> : null}
          {viewingCurrent ? <div className="phase-actions">
            {state === 'doc_review' ? <button className="button primary" onClick={() => void controller.approveDocs()} disabled={controller.working}><Check size={17} />批准规范并继续</button> : null}
            {state === 'ready' ? <>
              {executionBlocked ? <div className="execution-gate" role="status"><AlertTriangle size={16} /><div><strong>{!projectCheck.data?.isGit ? '先初始化 Git' : '先处理未提交改动'}</strong><span>{!projectCheck.data?.isGit ? '执行需要 Git 隔离 worktree。' : `检测到 ${projectCheck.data.changedFiles.length} 个改动文件，请提交或清理后再执行。`}</span></div></div> : null}
              <button className="button primary" onClick={() => void controller.execute()} disabled={controller.working || projectCheck?.status === 'loading' || executionBlocked}><GitMerge size={17} />{projectCheck?.status === 'loading' ? '检查项目…' : '拆分并执行'}</button>
            </> : null}
            {!data.currentProject?.isGit ? <button className="button secondary" onClick={() => void controller.initializeGit()}>初始化 Git</button> : null}
          </div> : <button className="text-action flow-return" onClick={() => setSelectedIndex(activeIndex)}>返回当前阶段</button>}
          {viewingCurrent && interrupted && run.blocker ? <RecoveryPanel controller={controller} /> : null}
          {viewingCurrent && run.pauseReason ? <div className="pause-callout"><strong>{interrupted ? '中断原因' : '当前提示'}</strong><p>{run.pauseReason}</p></div> : null}
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="flow-metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function RecoveryPanel({ controller }: { controller: LoopController }) {
  const run = controller.data.currentRun!;
  const blocker = run.blocker!;
  const [note, setNote] = useState('');
  const pendingApproval = blocker.kind === 'approval'
    ? controller.data.approvals.find((approval) => approval.id === blocker.approvalId && approval.status === 'pending')
      ?? controller.data.approvals.find((approval) => approval.status === 'pending')
    : undefined;
  const recovery = controller.recovery;
  const recoveryBusy = controller.recoveryStatus === 'loading';
  const recoveryError = controller.recoveryError;
  const actionAttempts = recovery?.actionAttempts ?? [];
  const unknownBudgets = recovery?.unknownBudgetReservations ?? [];
  const artifacts = recovery?.worktreeArtifacts ?? [];
  const events = recovery?.recentEvents ?? [];
  const evidence = recovery?.evidence;
  const actions = recovery?.recoveryActions ?? [];
  const canRecover = Boolean(recovery?.recoverable) && !pendingApproval;
  const performRecovery = (decision: RunRecoveryDecision) => {
    const action = actions.find((item) => item.decision === decision);
    if (!action?.available) return;
    const dangerous = action.risk === 'high';
    if (dangerous && !window.confirm(`${action.label}？\n\n影响范围：${evidence?.affectedResources.join('；') || '当前运行 generation'}\n此决定会写入恢复审计记录。`)) return;
    void controller.recoverRun(decision, note);
  };
  return <section className="recovery-panel" aria-labelledby="recovery-title">
    <div><strong id="recovery-title">恢复操作 · {blocker.kind}</strong><span>{blocker.message}</span></div>
    {pendingApproval ? <div className="recovery-approval"><small>{pendingApproval.risk} · {pendingApproval.capability} · {pendingApproval.resource}</small><p>{pendingApproval.summary}</p><div><button className="button secondary compact" disabled={controller.working} onClick={() => void controller.resolveApproval(pendingApproval.id, 'rejected')}>拒绝</button><button className="button primary compact" disabled={controller.working} onClick={() => void controller.resolveApproval(pendingApproval.id, 'approved', 'once')}>批准一次</button></div></div> : null}
    {!pendingApproval ? <div className="recovery-summary" aria-busy={recoveryBusy}>
      {recoveryBusy ? <div className="recovery-status"><RotateCcw size={15} /><span>正在读取恢复线索…</span></div> : null}
      {recoveryError ? <div className="recovery-status warning"><AlertTriangle size={15} /><span>{recoveryError}</span></div> : null}
      <div className="recovery-grid">
        <RecoveryMetric label="动作" value={String(actionAttempts.length)} note={actionAttempts.map((attempt) => `${attempt.sequence}:${attempt.status}`).join(' · ') || '无待核对动作'} />
        <RecoveryMetric label="预算" value={String(unknownBudgets.length)} note={unknownBudgets.length ? `${unknownBudgets.reduce((sum, item) => sum + item.reservedInputTokens + item.reservedOutputTokens, 0).toLocaleString()} token 预留未知` : '无未知预留'} />
        <RecoveryMetric label="Worktree" value={String(artifacts.length)} note={artifacts.map((artifact) => `${artifact.kind}/${artifact.status}`).join(' · ') || '无登记产物'} />
      </div>
      {evidence ? <div className="recovery-evidence">
        <section><strong>已知事实</strong><ul>{evidence.knownFacts.map((fact) => <li key={fact}>{fact}</li>)}</ul></section>
        <section className="unknown"><strong>需要人工确认</strong><ul>{evidence.unknownFacts.length ? evidence.unknownFacts.map((fact) => <li key={fact}>{fact}</li>) : <li>没有未确认事实</li>}</ul></section>
      </div> : null}
      {evidence?.checks.length ? <ul className="recovery-checks" aria-label="恢复检查项">{evidence.checks.map((check) => <li key={check.id} className={`check-${check.status}`}><span>{check.status === 'passed' ? <Check size={14} /> : <AlertTriangle size={14} />}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></li>)}</ul> : null}
      {evidence?.affectedResources.length ? <div className="recovery-resources"><strong>影响范围</strong><code>{evidence.affectedResources.join('\n')}</code></div> : null}
      {actionAttempts.length ? <ul className="recovery-list" aria-label="待核对动作">{actionAttempts.map((attempt) => <li key={attempt.id}><strong>{attempt.action.type}</strong><span>{attempt.id} · {attempt.status}{attempt.taskId ? ` · ${attempt.taskId}` : ''}</span></li>)}</ul> : null}
      {artifacts.length ? <ul className="recovery-list" aria-label="Worktree 产物">{artifacts.map((artifact) => <li key={artifact.id}><strong>{artifact.branch}</strong><span>{artifact.status} · {artifact.commitSha ?? 'no commit'} · {artifact.path}</span></li>)}</ul> : null}
      {events.length ? <div className="recovery-events"><strong>最近事件</strong><pre>{events.slice(-8).map((event) => `${event.id} ${event.type}`).join('\n')}</pre></div> : null}
      <label className="recovery-note"><span>恢复备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="记录你核对到的 worktree、命令输出或处理原因。" /></label>
    </div> : null}
    {!pendingApproval && blocker.kind === 'documents' ? <button className="button secondary" onClick={() => controller.setView('ide')}>打开规范并核对</button> : null}
    {!pendingApproval && actions.length ? <div className="recovery-actions"><button className="button secondary" onClick={() => controller.setView('ide')}>打开 IDE 核对</button>{actions.map((action) => <button key={action.decision} className={`button ${action.decision === 'resume' ? 'primary' : 'secondary'}`} title={action.disabledReason} disabled={controller.working || !canRecover || !action.available} onClick={() => performRecovery(action.decision)}>{action.decision === 'fail_and_retry' ? <XCircle size={15} /> : null}{action.label}</button>)}</div> : null}
    {run.state === 'failed' && blocker.recoverable ? <button className="button primary" disabled={controller.working} onClick={() => void controller.runAction('retry')}>重试失败阶段</button> : null}
  </section>;
}

function RecoveryMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}
