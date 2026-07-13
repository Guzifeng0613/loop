import { FolderPlus, X } from 'lucide-react';
import { useState } from 'react';
import type { LoopController } from '../useLoop';

export function AddProjectDialog({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const [rootPath, setRootPath] = useState('');

  const submit = async () => {
    const path = rootPath.trim();
    if (!path || controller.working) return;
    await controller.createProject(path);
    onClose();
  };

  return (
    <div className="modal-backdrop centered" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="add-project-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
        <header>
          <span className="dialog-symbol"><FolderPlus size={20} /></span>
          <div><span>本地工作区</span><h2 id="add-project-title">添加项目</h2></div>
          <button className="icon-button" aria-label="关闭添加项目" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="add-project-content">
          <label htmlFor="project-root">项目根目录</label>
          <input id="project-root" value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="例如 C:\\workspace\\my-app" autoFocus onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} />
          <p>Loop 只会在你明确选择的目录中读取文件。执行阶段需要 Git，非 Git 项目仍可先完成澄清与文档。</p>
        </div>
        <footer>
          <button className="button secondary" onClick={onClose}>取消</button>
          <button className="button primary" disabled={!rootPath.trim() || controller.working} onClick={() => void submit()}>验证并添加</button>
        </footer>
      </section>
    </div>
  );
}
