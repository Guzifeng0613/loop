import { Activity, CheckCircle2, FileClock, Network, ShieldAlert, X } from 'lucide-react';
import type { LoopController } from '../useLoop';

export function ActivityDrawer({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const events = [
    ...controller.data.messages.slice(-4).map((message) => ({ id: `m-${message.id}`, icon: FileClock, title: message.role === 'user' ? '用户补充了上下文' : 'Lead Main 更新理解', detail: message.content, time: message.createdAt })),
    ...controller.data.agents.slice(-4).map((agent) => ({ id: `a-${agent.id}`, icon: Network, title: `${agent.name} · ${agent.status}`, detail: `${agent.role} / ${agent.providerId} / ctx ${Math.round(agent.contextUsage * 100)}%`, time: new Date().toISOString() })),
    ...controller.data.approvals.slice(-4).map((approval) => ({ id: `p-${approval.id}`, icon: ShieldAlert, title: `${approval.tool} · ${approval.status}`, detail: approval.summary, time: approval.createdAt }))
  ].sort((a, b) => b.time.localeCompare(a.time));
  return (
    <aside className="activity-drawer">
      <header><div><Activity size={18} /><div><strong>运行活动</strong><span>SSE 实时事件与恢复线索</span></div></div><button className="icon-button" aria-label="关闭活动" onClick={onClose}><X size={18} /></button></header>
      <div className="activity-list">{events.length ? events.map(({ id, icon: Icon, title, detail, time }) => <div className="activity-item" key={id}><span><Icon size={16} /></span><div><strong>{title}</strong><p>{detail}</p><time>{new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div></div>) : <div className="activity-empty"><CheckCircle2 size={24} /><strong>暂无新事件</strong></div>}</div>
    </aside>
  );
}

