import { FolderOpen, FolderPlus, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import type { LoopController } from '../useLoop';
import { useDialog } from '../useDialog';
import { api } from '../api';

export function AddProjectDialog({ controller, onClose }: { controller: LoopController; onClose: () => void }) {
  const [rootPath, setRootPath] = useState('');
  const [picking, setPicking] = useState(false);
  const dialogRef = useDialog<HTMLElement>(onClose);

  const submit = async () => {
    const path = rootPath.trim();
    if (!path || controller.working) return;
    await controller.createProject(path);
    onClose();
  };

  const chooseDirectory = async () => {
    if (picking || controller.working) return;
    setPicking(true);
    try {
      const result = await api.pickProjectDirectory();
      if (result.path) setRootPath(result.path);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="modal-backdrop centered" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="add-project-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
        <header>
          <span className="dialog-symbol"><FolderPlus size={20} /></span>
          <div><span>本地工作区</span><h2 id="add-project-title">添加项目</h2></div>
          <button className="icon-button" aria-label="关闭添加项目" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="add-project-content">
          <label htmlFor="project-root">项目根目录</label>
          <div className="project-path-row">
            <input id="project-root" value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="选择文件夹，或输入路径" autoFocus data-dialog-initial-focus onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} />
            <button className="button secondary browse-button" type="button" onClick={() => void chooseDirectory()} disabled={picking || controller.working}>
              {picking ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />} {picking ? '打开中…' : '选择文件夹'}
            </button>
          </div>
          <p>Loop 只会在你明确选择的目录中读取文件。选择后会先验证目录并同步项目文档，执行阶段需要 Git。</p>
        </div>
        <footer>
          <button className="button secondary" onClick={onClose}>取消</button>
          <button className="button primary" disabled={!rootPath.trim() || controller.working} onClick={() => void submit()}>验证并添加</button>
        </footer>
      </section>
    </div>
  );
}
