import { Check, KeyRound, Shield, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LoopController } from '../useLoop';
import { useDialog } from '../useDialog';

export function SettingsPanel({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const [keys, setKeys] = useState({ openai: '', deepseek: '' });
  const [concurrency, setConcurrency] = useState(controller.data.settings.concurrency);
  const [maxDepth, setMaxDepth] = useState(controller.data.settings.maxDepth);
  const [maxAgents, setMaxAgents] = useState(controller.data.settings.maxAgents);
  const [mainDirectLimit, setMainDirectLimit] = useState(controller.data.settings.mainDirectLimit);
  const [autoMode, setAutoMode] = useState(controller.data.settings.autoMode);
  const [budget, setBudget] = useState(controller.data.settings.budget);
  const dialogRef = useDialog<HTMLElement>(onClose);
  useEffect(() => {
    void controller.loadDiagnostics().catch(() => undefined);
  }, [controller.loadDiagnostics]);
  const diagnostics = controller.diagnostics;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><span>本机配置</span><h2 id="settings-title">设置</h2></div><button className="icon-button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button></header>
        <div className="settings-content">
          <section className="settings-section"><div className="settings-section-title"><KeyRound size={18} /><div><strong>模型供应商</strong><span>密钥保存到 Windows 凭据管理器</span></div></div>
            {controller.data.providers.filter((provider) => provider.id !== 'local-demo').map((provider) => (
              <div className="provider-row" key={provider.id}><div className="provider-identity"><span className={`provider-logo ${provider.id}`}>{provider.id === 'openai' ? 'O' : 'D'}</span><div><strong>{provider.label}</strong><small>{provider.configured ? <><Check size={12} />已配置</> : '未配置'}</small></div></div><div className="key-field"><input type="password" value={keys[provider.id as 'openai' | 'deepseek']} onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder="输入新的 API key" autoComplete="off" /><button disabled={!keys[provider.id as 'openai' | 'deepseek'] || controller.working} onClick={() => void controller.saveProvider(provider.id as 'openai' | 'deepseek', keys[provider.id as 'openai' | 'deepseek']).then(() => setKeys((current) => ({ ...current, [provider.id]: '' })))}>保存</button>{provider.configured ? <button className="clear-provider" disabled={controller.working} onClick={() => { if (window.confirm(`清除 ${provider.label} 的本机凭据？`)) void controller.clearProvider(provider.id as 'openai' | 'deepseek'); }}>清除</button> : null}</div></div>
            ))}
          </section>
          <section className="settings-section"><div className="settings-section-title"><Shield size={18} /><div><strong>Agent 与权限</strong><span>硬安全线不会被全自动模式绕过</span></div></div>
            <label className="range-setting"><span><strong>并发 Agent</strong><small>可配置 1–16</small></span><input type="range" min="1" max="16" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /><b>{concurrency}</b></label>
            <label className="range-setting"><span><strong>子 Agent 深度</strong><small>硬上限 4 层</small></span><input type="range" min="1" max="4" value={maxDepth} onChange={(event) => setMaxDepth(Number(event.target.value))} /><b>{maxDepth}</b></label>
            <label className="range-setting"><span><strong>最大 Agent</strong><small>单次运行硬上限 200</small></span><input type="range" min="1" max="200" value={maxAgents} onChange={(event) => { const value = Number(event.target.value); setMaxAgents(value); setMainDirectLimit((current) => Math.min(current, value)); }} /><b>{maxAgents}</b></label>
            <label className="range-setting"><span><strong>Lead 直属任务</strong><small>最多 30 个，且不超过总量</small></span><input type="range" min="1" max={Math.min(30, maxAgents)} value={mainDirectLimit} onChange={(event) => setMainDirectLimit(Number(event.target.value))} /><b>{mainDirectLimit}</b></label>
            <label className="toggle-setting"><span><strong>项目内全自动</strong><small>未知命令仍受硬安全线与审批策略约束</small></span><input type="checkbox" checked={autoMode} onChange={(event) => setAutoMode(event.target.checked)} /><i /></label>
          </section>
          <section className="settings-section"><div className="settings-section-title"><Shield size={18} /><div><strong>单次运行预算</strong><span>任一上限触发时安全暂停，不丢弃已有结果</span></div></div><div className="budget-fields">
            <label><span>模型调用</span><input type="number" min="1" value={budget.maxCalls} onChange={(event) => setBudget((current) => ({ ...current, maxCalls: Number(event.target.value) }))} /></label>
            <label><span>输入 token</span><input type="number" min="1" value={budget.maxInputTokens} onChange={(event) => setBudget((current) => ({ ...current, maxInputTokens: Number(event.target.value) }))} /></label>
            <label><span>输出 token</span><input type="number" min="1" value={budget.maxOutputTokens} onChange={(event) => setBudget((current) => ({ ...current, maxOutputTokens: Number(event.target.value) }))} /></label>
            <label><span>运行分钟</span><input type="number" min="1" value={budget.maxMinutes} onChange={(event) => setBudget((current) => ({ ...current, maxMinutes: Number(event.target.value) }))} /></label>
          </div></section>
          <section className="budget-summary"><div><span>已用调用</span><strong>{controller.data.usage.calls}</strong></div><div><span>已用输入</span><strong>{controller.data.usage.inputTokens.toLocaleString()}</strong></div><div><span>已运行</span><strong>{Math.round(controller.data.usage.elapsedMinutes)}m</strong></div></section>
          <section className="settings-section"><div className="settings-section-title"><Shield size={18} /><div><strong>运行诊断</strong><span>用于核对恢复、预算与本地存储一致性</span></div></div>
            {controller.diagnosticsStatus === 'loading' ? <div className="diagnostics-status">正在读取诊断快照…</div> : null}
            {controller.diagnosticsStatus === 'error' ? <div className="diagnostics-status warning">{controller.diagnosticsError ?? '诊断读取失败'}</div> : null}
            {diagnostics ? <div className="diagnostics-grid">
              <div><span>数据库</span><strong>{diagnostics.database.integrity}</strong><small>schema v{diagnostics.database.schemaVersion} · WAL {Math.round(diagnostics.database.walBytes / 1024).toLocaleString()} KB</small></div>
              <div><span>未知操作</span><strong>{diagnostics.operations.unknown}</strong><small>{diagnostics.operations.pending} 个操作尚未结束</small></div>
              <div><span>未知预算</span><strong>{diagnostics.budgets.unknown}</strong><small>{diagnostics.budgets.queued + diagnostics.budgets.dispatched} 笔排队或派发中</small></div>
              <div><span>Worktree</span><strong>{diagnostics.worktrees.orphaned}</strong><small>{Math.round(diagnostics.worktrees.usedBytes / 1024 / 1024).toLocaleString()} / {Math.round(diagnostics.worktrees.quotaBytes / 1024 / 1024).toLocaleString()} MB</small></div>
              <div><span>事件水位</span><strong>{diagnostics.eventWatermark}</strong><small>快照生成于 {new Date(diagnostics.createdAt).toLocaleTimeString('zh-CN')}</small></div>
              <div><span>供应商</span><strong>{diagnostics.providers.filter((provider) => provider.ready).length}/{diagnostics.providers.length}</strong><small>已就绪</small></div>
            </div> : null}
          </section>
        </div>
        <footer><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={controller.working} onClick={() => void controller.saveSettings({ concurrency, maxDepth, maxAgents, mainDirectLimit, autoMode, budget }).then(onClose)}>保存设置</button></footer>
      </section>
    </div>
  );
}
