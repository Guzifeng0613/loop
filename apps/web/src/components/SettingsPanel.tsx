import { Check, KeyRound, Shield, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LoopController } from '../useLoop';

export function SettingsPanel({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const [keys, setKeys] = useState({ openai: '', deepseek: '' });
  const [concurrency, setConcurrency] = useState(controller.data.settings.concurrency);
  const [maxDepth, setMaxDepth] = useState(controller.data.settings.maxDepth);
  const [autoMode, setAutoMode] = useState(controller.data.settings.autoMode);
  useEffect(() => {
    setConcurrency(controller.data.settings.concurrency);
    setMaxDepth(controller.data.settings.maxDepth);
    setAutoMode(controller.data.settings.autoMode);
  }, [controller.data.settings]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><span>本机配置</span><h2 id="settings-title">设置</h2></div><button className="icon-button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button></header>
        <div className="settings-content">
          <section className="settings-section"><div className="settings-section-title"><KeyRound size={18} /><div><strong>模型供应商</strong><span>密钥保存到 Windows 凭据管理器</span></div></div>
            {controller.data.providers.filter((provider) => provider.id !== 'local-demo').map((provider) => (
              <div className="provider-row" key={provider.id}><div className="provider-identity"><span className={`provider-logo ${provider.id}`}>{provider.id === 'openai' ? 'O' : 'D'}</span><div><strong>{provider.label}</strong><small>{provider.configured ? <><Check size={12} />已配置</> : '未配置'}</small></div></div><div className="key-field"><input type="password" value={keys[provider.id as 'openai' | 'deepseek']} onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder="输入新的 API key" autoComplete="off" /><button disabled={!keys[provider.id as 'openai' | 'deepseek'] || controller.working} onClick={() => void controller.saveProvider(provider.id as 'openai' | 'deepseek', keys[provider.id as 'openai' | 'deepseek']).then(() => setKeys((current) => ({ ...current, [provider.id]: '' })))}>保存</button></div></div>
            ))}
          </section>
          <section className="settings-section"><div className="settings-section-title"><Shield size={18} /><div><strong>Agent 与权限</strong><span>硬安全线不会被全自动模式绕过</span></div></div>
            <label className="range-setting"><span><strong>并发 Agent</strong><small>可配置 1–16</small></span><input type="range" min="1" max="16" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /><b>{concurrency}</b></label>
            <label className="range-setting"><span><strong>子 Agent 深度</strong><small>硬上限 4 层</small></span><input type="range" min="1" max="4" value={maxDepth} onChange={(event) => setMaxDepth(Number(event.target.value))} /><b>{maxDepth}</b></label>
            <label className="toggle-setting"><span><strong>项目内全自动</strong><small>未知项目命令不再逐次询问</small></span><input type="checkbox" checked={autoMode} onChange={(event) => setAutoMode(event.target.checked)} /><i /></label>
          </section>
          <section className="budget-summary"><div><span>默认模型调用</span><strong>{controller.data.settings.budget.maxCalls}</strong></div><div><span>最大 Agent</span><strong>{controller.data.settings.maxAgents}</strong></div><div><span>运行时间</span><strong>{controller.data.settings.budget.maxMinutes}m</strong></div></section>
        </div>
        <footer><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={controller.working} onClick={() => void controller.saveSettings({ concurrency, maxDepth, autoMode }).then(onClose)}>保存设置</button></footer>
      </section>
    </div>
  );
}

