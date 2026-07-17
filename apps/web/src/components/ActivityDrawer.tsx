import { Activity, AlertTriangle, Bot, CheckCircle2, FileClock, Gauge, Network, ShieldAlert, TerminalSquare, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RunEvent } from '@loop/contracts';
import type { LoopController } from '../useLoop';

export interface EventPresentation {
  icon: typeof Activity;
  title: string;
  detail: string;
  outputId?: string;
  truncated?: boolean;
}

export function eventPresentation(event: RunEvent): EventPresentation {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  switch (event.type) {
    case 'message.delta':
      return { icon: FileClock, title: '对话生成中', detail: String(payload.delta ?? payload.content ?? '') };
    case 'message.completed':
      return { icon: FileClock, title: '对话已记录', detail: String(payload.content ?? 'Lead Main 更新了运行上下文') };
    case 'run.state':
      return { icon: Activity, title: `运行状态 · ${String(payload.state ?? '已更新')}`, detail: String(payload.reason ?? payload.blocker ?? '状态机已写入事件记录') };
    case 'agent.state':
      return { icon: Bot, title: `Agent · ${String(payload.status ?? '已更新')}`, detail: `${String(payload.agentId ?? '')} · 上下文 ${Math.round(Number(payload.contextUsage ?? 0) * 100)}%` };
    case 'task.state':
      return {
        icon: Network,
        title: `任务 · ${String(payload.status ?? (payload.verified === true ? '已验证' : '已更新'))}`,
        detail: String(payload.taskId ?? '')
      };
    case 'task.result':
      return {
        icon: CheckCircle2,
        title: `任务结果 · ${payload.verified === true ? '已验证' : '待验证'}`,
        detail: String(payload.summary ?? payload.taskId ?? payload.resultId ?? '')
      };
    case 'artifact.updated':
      return {
        icon: Network,
        title: `工作树产物 · ${String(payload.status ?? '已更新')}`,
        detail: String(payload.branch ?? payload.path ?? payload.artifactId ?? '')
      };
    case 'delivery.updated':
      return {
        icon: CheckCircle2,
        title: '交付摘要已更新',
        detail: String(payload.integrationBranch ?? payload.runId ?? '可以进入用户验收')
      };
    case 'tool.output':
      return {
        icon: TerminalSquare,
        title: `命令输出 · ${String(payload.tool ?? 'workflow')}`,
        detail: String(payload.preview ?? payload.output ?? ''),
        ...(payload.outputId ? { outputId: String(payload.outputId) } : {}),
        truncated: Boolean(payload.truncated)
      };
    case 'approval.requested':
      return { icon: ShieldAlert, title: `等待审批 · ${String(payload.tool ?? '工具调用')}`, detail: String(payload.policyReason ?? payload.summary ?? '') };
    case 'approval.resolved':
      return { icon: ShieldAlert, title: `审批已${payload.status === 'approved' ? '批准' : payload.status === 'rejected' ? '拒绝' : '处理'}`, detail: String(payload.summary ?? payload.tool ?? payload.id ?? '') };
    case 'budget.updated': {
      const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : payload;
      const calls = Number(usage.calls ?? 0);
      const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
      return { icon: Gauge, title: '预算消耗已更新', detail: `${calls} 次调用 · ${inputTokens.toLocaleString()} 输入 token` };
    }
    case 'doc.invalidated':
      return { icon: FileClock, title: '文档引用已过期', detail: String(payload.reason ?? `计划代次已更新为 ${String(payload.generation ?? '新版本')}`) };
    case 'error':
      return { icon: AlertTriangle, title: '运行异常', detail: String(payload.message ?? '请检查恢复提示') };
    default: {
      const exhaustive: never = event.type;
      return { icon: AlertTriangle, title: '未知事件', detail: String(exhaustive) };
    }
  }
}

export function ActivityDrawer({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const events = [...controller.data.events].reverse().map((event) => ({ id: event.id, time: event.createdAt, ...eventPresentation(event) }));
  const usage = controller.data.usage;
  const [expanded, setExpanded] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [outputErrors, setOutputErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setExpanded({});
    setLoading({});
    setOutputErrors({});
  }, [controller.data.currentRun?.id]);

  const expandOutput = async (outputId: string) => {
    if (Object.prototype.hasOwnProperty.call(expanded, outputId)) {
      setExpanded((current) => { const next = { ...current }; delete next[outputId]; return next; });
      setOutputErrors((current) => { const next = { ...current }; delete next[outputId]; return next; });
      return;
    }
    setLoading((current) => ({ ...current, [outputId]: true }));
    setOutputErrors((current) => { const next = { ...current }; delete next[outputId]; return next; });
    try {
      const output = await controller.getToolOutput(outputId);
      setExpanded((current) => ({ ...current, [outputId]: output.content }));
    } catch (reason) {
      setOutputErrors((current) => ({ ...current, [outputId]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setLoading((current) => ({ ...current, [outputId]: false }));
    }
  };

  const copyOutput = async (outputId: string) => {
    try {
      if (!navigator.clipboard) throw new Error('当前环境不支持剪贴板写入');
      await navigator.clipboard.writeText(expanded[outputId] ?? '');
      setOutputErrors((current) => { const next = { ...current }; delete next[outputId]; return next; });
    } catch (reason) {
      setOutputErrors((current) => ({ ...current, [outputId]: reason instanceof Error ? reason.message : String(reason) }));
    }
  };

  return (
    <aside className="activity-drawer" aria-label="运行活动">
      <header><div><Activity size={18} /><div><strong>运行活动</strong><span><i className={`connection-dot ${controller.connectionState}`} />{controller.connectionState === 'live' ? '实时连接' : controller.connectionState === 'connecting' ? '正在连接' : controller.connectionState === 'reconnecting' ? '正在重连' : '离线'}</span></div></div><button className="icon-button" aria-label="关闭活动" onClick={onClose}><X size={18} /></button></header>
      <div className="activity-body"><div className="activity-usage" aria-label="运行预算消耗"><span><strong>{usage.calls}</strong> / {controller.data.settings.budget.maxCalls} 次调用</span><span>{usage.inputTokens.toLocaleString()} 输入</span><span>{Math.round(usage.elapsedMinutes)} / {controller.data.settings.budget.maxMinutes} 分钟</span></div><div className="activity-list">{events.length ? events.map(({ id, icon: Icon, title, detail, time, outputId, truncated }) => {
        const isExpanded = Boolean(outputId && Object.prototype.hasOwnProperty.call(expanded, outputId));
        const outputError = outputId ? outputErrors[outputId] : undefined;
        return <div className="activity-item" key={id}><span><Icon size={16} /></span><div><strong>{title}</strong><p className={isExpanded ? 'expanded' : ''}>{outputError ?? (outputId && isExpanded ? expanded[outputId] : detail)}</p>{outputId && truncated ? <div className="output-actions"><button disabled={Boolean(loading[outputId])} onClick={() => void expandOutput(outputId)}>{loading[outputId] ? '正在读取…' : isExpanded ? '收起输出' : '展开完整输出'}</button>{isExpanded ? <button onClick={() => void copyOutput(outputId)}>复制</button> : null}</div> : null}<time>{new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div></div>;
      }) : <div className="activity-empty"><CheckCircle2 size={24} /><strong>暂无新事件</strong></div>}</div></div>
    </aside>
  );
}
