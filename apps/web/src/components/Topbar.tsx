import { Activity, CircleStop, Play, ScrollText } from 'lucide-react';
import type { LoopController } from '../useLoop';

const stateLabels: Record<string, string> = {
  intake: '接收问题', clarifying: '深究中', doc_review: '等待规范确认', ready: '可以执行', decomposing: '拆分任务',
  executing: 'Agent 执行中', integrating: '集成中', verifying: '验证中', optimizing: '优化中', completed: '已完成',
  paused: '已暂停', failed: '失败', cancelled: '已取消'
};

export function Topbar({ controller, onActivity }: { controller: LoopController; onActivity: () => void }) {
  const run = controller.data.currentRun;
  const running = run && ['decomposing', 'executing', 'integrating', 'verifying', 'optimizing'].includes(run.state);
  return (
    <header className="topbar">
      <div className="topbar-context">
        <div className="run-heading">
          <h1>{run?.title ?? '选择一个运行'}</h1>
          {run ? <span className={`state-label state-${run.state}`}>{stateLabels[run.state] ?? run.state}</span> : null}
        </div>
        <p>{run?.pauseReason ?? '文档、任务与 Agent 共享一个可恢复状态。'}</p>
      </div>
      <div className="topbar-actions">
        <div className="model-summary"><ScrollText size={15} /><span>{run?.modelMode === 'auto' ? '智能路由' : run?.model ?? '未配置模型'}</span></div>
        <button className="button secondary compact" onClick={onActivity}><Activity size={16} />活动</button>
        {running ? (
          <button className="button secondary compact" disabled={controller.working} onClick={() => void controller.runAction('pause')}><CircleStop size={16} />暂停</button>
        ) : run?.state === 'paused' ? (
          <button className="button primary compact" disabled={controller.working} onClick={() => void controller.runAction('resume')}><Play size={16} />继续</button>
        ) : null}
      </div>
    </header>
  );
}

