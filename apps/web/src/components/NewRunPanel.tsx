import { Bot, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ProviderId } from '@loop/contracts';
import type { LoopController } from '../useLoop';

export function NewRunPanel({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const availableProviders = controller.data.providers.filter((provider) => provider.configured);
  const initialProvider = availableProviders.find((provider) => provider.id !== 'local-demo') ?? availableProviders[0];
  const [title, setTitle] = useState('新的开发任务');
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<'fixed' | 'auto'>('fixed');
  const [providerId, setProviderId] = useState<ProviderId>(initialProvider?.id ?? 'local-demo');
  const provider = useMemo(() => controller.data.providers.find((item) => item.id === providerId), [controller.data.providers, providerId]);
  const [model, setModel] = useState(initialProvider?.defaultModel ?? 'local-structured-demo');

  const selectProvider = (next: ProviderId) => {
    setProviderId(next);
    setModel(controller.data.providers.find((item) => item.id === next)?.defaultModel ?? 'local-structured-demo');
  };
  const submit = async () => {
    if (!controller.data.currentProject || !question.trim()) return;
    await controller.createRun({
      projectId: controller.data.currentProject.id,
      title: title.trim() || '新的开发任务',
      question: question.trim(),
      modelMode: mode,
      providerId,
      model
    });
    onClose();
  };

  return (
    <div className="modal-backdrop centered" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="new-run-panel" role="dialog" aria-modal="true" aria-labelledby="new-run-title">
        <header><div className="dialog-symbol"><Bot size={20} /></div><div><span>新建运行</span><h2 id="new-run-title">先把问题交给 Lead Main</h2></div><button className="icon-button" aria-label="关闭新建运行" onClick={onClose}><X size={18} /></button></header>
        <div className="new-run-form">
          <label><span>运行名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>你想解决什么问题？</span><textarea rows={7} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="描述目标、当前状态、限制和期望结果。Lead Main 会先深究而不是立即执行。" autoFocus /></label>
          <div className="mode-selector" role="radiogroup" aria-label="模型路由模式">
            <button className={mode === 'fixed' ? 'active' : ''} onClick={() => setMode('fixed')}><strong>固定模型</strong><span>整次运行只使用一个供应商</span></button>
            <button className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}><strong>智能路由</strong><span>Lead Main 可为子任务选择模型</span></button>
          </div>
          <div className="run-model-row">
            <label><span>Lead 供应商</span><select value={providerId} onChange={(event) => selectProvider(event.target.value as ProviderId)}>{availableProviders.map((item) => <option key={item.id} value={item.id}>{item.label}{item.id === 'local-demo' ? '（不调用 API）' : ''}</option>)}</select></label>
            <label><span>Lead 模型</span><select value={model} onChange={(event) => setModel(event.target.value)}>{provider?.availableModels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          </div>
          {mode === 'auto' ? <p className="routing-note">自动模式只会在已配置并启用的供应商之间路由；每个任务卡会显示最终选择。</p> : null}
        </div>
        <footer><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!question.trim() || controller.working} onClick={() => void submit()}>开始深究</button></footer>
      </section>
    </div>
  );
}
