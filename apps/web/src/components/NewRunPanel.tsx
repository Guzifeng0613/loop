import { Bot, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ProviderId } from '@loop/contracts';
import type { LoopController } from '../useLoop';
import { useDialog } from '../useDialog';

export function NewRunPanel({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const realProviders = controller.data.providers.filter((provider) => provider.configured && provider.id !== 'local-demo');
  const initialProvider = realProviders[0];
  const [title, setTitle] = useState('新的开发任务');
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<'fixed' | 'auto'>('fixed');
  const [demoMode, setDemoMode] = useState(false);
  const availableProviders = controller.data.providers.filter((provider) =>
    provider.configured && (provider.id !== 'local-demo' || demoMode)
  );
  const [providerId, setProviderId] = useState<ProviderId | ''>(initialProvider?.id ?? '');
  const [allowedProviderIds, setAllowedProviderIds] = useState<ProviderId[]>(realProviders.map((item) => item.id));
  const provider = useMemo(() => controller.data.providers.find((item) => item.id === providerId), [controller.data.providers, providerId]);
  const [model, setModel] = useState(initialProvider?.defaultModel ?? '');
  const dialogRef = useDialog<HTMLElement>(onClose);

  const selectProvider = (next: ProviderId) => {
    setProviderId(next);
    setModel(controller.data.providers.find((item) => item.id === next)?.defaultModel ?? 'local-structured-demo');
  };
  const submit = async () => {
    if (!controller.data.currentProject || !question.trim() || !providerId || !model) return;
    await controller.createRun({
      projectId: controller.data.currentProject.id,
      title: title.trim() || '新的开发任务',
      question: question.trim(),
      modelMode: mode,
      providerId,
      model,
      allowedProviderIds: mode === 'fixed' ? [providerId] : (allowedProviderIds.length ? allowedProviderIds : [providerId])
    });
    onClose();
  };

  return (
    <div className="modal-backdrop centered" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="new-run-panel" role="dialog" aria-modal="true" aria-labelledby="new-run-title">
        <header><div className="dialog-symbol"><Bot size={20} /></div><div><span>新建运行</span><h2 id="new-run-title">先把问题交给 Lead Main</h2></div><button className="icon-button" aria-label="关闭新建运行" onClick={onClose}><X size={18} /></button></header>
        <div className="new-run-form">
          <label><span>运行名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>你想解决什么问题？</span><textarea rows={7} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="描述目标、当前状态、限制和期望结果。Lead Main 会先深究而不是立即执行。" autoFocus /></label>
          {!controller.data.currentProject ? <p className="form-warning" role="alert">请先添加并选择本地项目，才能创建运行。</p> : null}
          {!realProviders.length ? <p className="form-warning" role="status">尚未配置真实模型供应商。可先前往设置填写凭据，或明确启用下方演示模式。</p> : null}
          <label className="demo-mode-confirm"><input type="checkbox" checked={demoMode} onChange={(event) => {
            const enabled = event.target.checked;
            setDemoMode(enabled);
            if (enabled && !providerId) selectProvider('local-demo');
            if (!enabled && providerId === 'local-demo') {
              const fallback = realProviders[0];
              setProviderId(fallback?.id ?? '');
              setModel(fallback?.defaultModel ?? '');
              setAllowedProviderIds((current) => current.filter((id) => id !== 'local-demo'));
            }
          }} /><span><strong>明确启用本地演示</strong><small>不调用真实模型，结果只计入演示指标且不会自动回退到此模式。</small></span></label>
          <div className="mode-selector" role="radiogroup" aria-label="模型路由模式" onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' || event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 'fixed' : 'auto';
            setMode(next);
            requestAnimationFrame(() => event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus());
          }}>
            <button data-mode="fixed" role="radio" tabIndex={mode === 'fixed' ? 0 : -1} aria-checked={mode === 'fixed'} className={mode === 'fixed' ? 'active' : ''} onClick={() => setMode('fixed')}><strong>固定模型</strong><span>稳定默认：整次运行使用一个供应商</span></button>
            <button data-mode="auto" role="radio" tabIndex={mode === 'auto' ? 0 : -1} aria-checked={mode === 'auto'} className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}><strong>智能路由 · 实验</strong><span>Lead Main 可为子任务选择模型</span></button>
          </div>
          <div className="run-model-row">
            <label><span>Lead 供应商</span><select value={providerId} onChange={(event) => selectProvider(event.target.value as ProviderId)}><option value="" disabled>请选择已配置供应商</option>{availableProviders.map((item) => <option key={item.id} value={item.id}>{item.label}{item.id === 'local-demo' ? '（明确演示）' : ''}</option>)}</select></label>
            <label><span>Lead 模型</span><select value={model} onChange={(event) => setModel(event.target.value)}>{provider?.availableModels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          </div>
          {mode === 'auto' ? <fieldset className="provider-allowlist"><legend>子任务允许使用</legend><div>{availableProviders.map((item) => {
            const checked = allowedProviderIds.includes(item.id);
            return <label key={item.id}><input type="checkbox" checked={checked} onChange={() => setAllowedProviderIds((current) => checked ? current.filter((id) => id !== item.id) : [...current, item.id])} /><span><strong>{item.label}</strong><small>{item.defaultModel}</small></span></label>;
          })}</div><p className="routing-note">Lead 固定使用上方模型；子任务只会在勾选且已配置的供应商间路由。</p></fieldset> : null}
        </div>
        <footer><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!controller.data.currentProject || !question.trim() || !providerId || !model || controller.working} title={!controller.data.currentProject ? '请先添加项目' : !providerId ? '请配置真实供应商或明确启用演示模式' : undefined} onClick={() => void submit()}>开始深究</button></footer>
      </section>
    </div>
  );
}
