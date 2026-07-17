import { ChevronDown, ChevronRight, Columns2, FileCode2, FileText, Folder, PanelRightOpen, Pencil, Save, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { LoopDocument } from '@loop/contracts';
import { isDocumentContentLoaded, type LoopController } from '../useLoop';
import { buildDocumentDiff } from '../documentDiff';
import { MobileInspectorDrawer } from '../components/MobileInspectorDrawer';

const DRAFT_STORAGE_KEY = 'loop.ide.drafts.v1';

export interface DocumentDraft {
  content: string;
  baseHash: string;
  updatedAt: string;
}

export function hasDocumentDraftConflict(draft: DocumentDraft | undefined, document: LoopDocument): boolean {
  return Boolean(draft && draft.content !== document.content && draft.baseHash !== document.hash);
}

export function parseDocumentDrafts(raw: string | null): Record<string, DocumentDraft> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const drafts: Record<string, DocumentDraft> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.content !== 'string' || typeof candidate.baseHash !== 'string' || typeof candidate.updatedAt !== 'string') continue;
      drafts[key] = { content: candidate.content, baseHash: candidate.baseHash, updatedAt: candidate.updatedAt };
    }
    return drafts;
  } catch {
    return {};
  }
}

export function IdeView({ controller, initialDocument }: { controller: LoopController; initialDocument?: LoopDocument }) {
  const [selectedId, setSelectedId] = useState(initialDocument?.id ?? controller.data.documents[0]?.id);
  const selected = controller.data.documents.find((doc) => doc.id === selectedId) ?? controller.data.documents[0];
  const documentContentLoaded = selected ? isDocumentContentLoaded(selected) : false;
  const [content, setContent] = useState(documentContentLoaded ? selected?.content ?? '' : '');
  const [editorMode, setEditorMode] = useState<'edit' | 'diff'>('edit');
  const [draftSaved, setDraftSaved] = useState(false);
  const [draftConflict, setDraftConflict] = useState<DocumentDraft>();
  const [draftStorageError, setDraftStorageError] = useState<string>();
  const [documentLoadError, setDocumentLoadError] = useState<{ key: string; message: string }>();
  const [documentLoadAttempt, setDocumentLoadAttempt] = useState(0);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const draftsRef = useRef(loadDrafts());
  const activeDraftKeyRef = useRef<string | undefined>(undefined);
  const draftKey = selected ? `${controller.data.currentProject?.id ?? 'none'}:${selected.id}` : undefined;
  activeDraftKeyRef.current = draftKey;

  const flushDrafts = useCallback((report = true) => {
    const saved = storeDrafts(draftsRef.current);
    if (report) {
      const activeKey = activeDraftKeyRef.current;
      setDraftSaved(saved && Boolean(activeKey && draftsRef.current[activeKey]));
      setDraftStorageError(saved ? undefined : '本机草稿写入失败；请复制当前内容后检查浏览器存储空间。');
    }
    return saved;
  }, []);

  useEffect(() => { if (initialDocument) setSelectedId(initialDocument.id); }, [initialDocument]);

  useEffect(() => {
    if (!selected || !draftKey || documentContentLoaded) {
      setDocumentLoadError(undefined);
      return;
    }
    setContent('');
    setDraftConflict(undefined);
    setDraftSaved(false);
    setDocumentLoadError(undefined);
    if (!controller.data.currentRun) return;
    let active = true;
    void controller.loadDocument(selected.id).catch((reason) => {
      if (!active) return;
      setDocumentLoadError({ key: draftKey, message: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => { active = false; };
  }, [controller.data.currentRun?.id, controller.loadDocument, documentContentLoaded, documentLoadAttempt, draftKey, selected?.hash, selected?.id]);

  useEffect(() => {
    if (!selected || !draftKey) {
      setContent('');
      setDraftConflict(undefined);
      setDraftSaved(false);
      return;
    }
    if (!documentContentLoaded) {
      setContent('');
      setDraftConflict(undefined);
      setDraftSaved(false);
      return;
    }
    let draft = draftsRef.current[draftKey];
    if (draft?.content === selected.content) {
      delete draftsRef.current[draftKey];
      draft = undefined;
    }
    setContent(draft?.content ?? selected.content);
    setDraftConflict(hasDocumentDraftConflict(draft, selected) ? draft : undefined);
    if (draft) {
      const saved = storeDrafts(draftsRef.current);
      setDraftSaved(saved);
      setDraftStorageError(saved ? undefined : '本机草稿写入失败；请复制当前内容后检查浏览器存储空间。');
    } else {
      const saved = storeDrafts(draftsRef.current);
      setDraftSaved(false);
      if (!saved) setDraftStorageError('本机草稿写入失败；请复制当前内容后检查浏览器存储空间。');
    }
  }, [documentContentLoaded, draftKey, selected?.content, selected?.hash, selected?.id]);

  const dirty = Boolean(selected && documentContentLoaded && content !== selected.content);

  useEffect(() => {
    if (!selected || !draftKey || !documentContentLoaded) return;
    const timer = window.setTimeout(() => { flushDrafts(true); }, 180);
    return () => window.clearTimeout(timer);
  }, [content, documentContentLoaded, draftKey, flushDrafts, selected?.hash]);

  useEffect(() => () => { flushDrafts(false); }, [draftKey, flushDrafts]);

  useEffect(() => {
    if (!dirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      flushDrafts(false);
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [dirty, flushDrafts]);

  const diff = useMemo(() => buildDocumentDiff(selected?.content ?? '', content), [selected?.content, content]);
  const events = useMemo(() => controller.data.events.slice(-20).map((event) => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
    return `[${event.id}] ${event.type}  ${String(payload.preview ?? payload.output ?? payload.message ?? payload.status ?? payload.tool ?? '')}`.trimEnd();
  }), [controller.data.events]);

  const updateContent = (nextContent: string) => {
    if (!documentContentLoaded) return;
    if (selected && draftKey) {
      if (nextContent === selected.content) {
        delete draftsRef.current[draftKey];
        setDraftConflict(undefined);
      } else {
        const existing = draftsRef.current[draftKey];
        const draft: DocumentDraft = {
          content: nextContent,
          baseHash: existing?.baseHash ?? selected.hash,
          updatedAt: new Date().toISOString()
        };
        draftsRef.current[draftKey] = draft;
        setDraftConflict(hasDocumentDraftConflict(draft, selected) ? draft : undefined);
      }
      setDraftSaved(false);
    }
    setContent(nextContent);
  };

  const save = async () => {
    if (!selected || !draftKey) return;
    if (!documentContentLoaded || !controller.data.currentRun || draftConflict) {
      flushDrafts(true);
      return;
    }
    const savedContent = content;
    await controller.saveDocument(selected, savedContent);
    const newerDraft = draftsRef.current[draftKey];
    if (newerDraft && newerDraft.content !== savedContent) {
      flushDrafts(true);
      return;
    }
    delete draftsRef.current[draftKey];
    const stored = storeDrafts(draftsRef.current);
    setDraftStorageError(stored ? undefined : '文档已保存，但旧本机草稿暂时无法清除。');
    setDraftSaved(false);
    setDraftConflict(undefined);
  };

  const selectDocument = (nextId: string) => {
    flushDrafts(true);
    setSelectedId(nextId);
  };

  const useServerVersion = () => {
    if (!selected || !draftKey || !documentContentLoaded || !window.confirm('放弃本机冲突草稿并载入服务器最新版本？')) return;
    delete draftsRef.current[draftKey];
    const stored = storeDrafts(draftsRef.current);
    setDraftStorageError(stored ? undefined : '服务器版本已载入，但旧本机草稿暂时无法清除。');
    setDraftConflict(undefined);
    setDraftSaved(false);
    setContent(selected.content);
  };

  const currentLoadError = documentLoadError && documentLoadError.key === draftKey ? documentLoadError.message : undefined;
  const documentLoading = Boolean(selected && !documentContentLoaded && controller.data.currentRun && !currentLoadError);
  const editorNotice = selected && !documentContentLoaded
    ? currentLoadError
      ? { title: '文档正文加载失败', body: currentLoadError, action: 'retry' as const }
      : !controller.data.currentRun
        ? { title: '当前没有可读取正文的运行', body: '选择或创建运行后才能按需加载并编辑这份规范文档。' }
        : { title: '正在加载文档正文', body: '正文到达前编辑与保存保持锁定，本机草稿不会被覆盖。' }
    : draftConflict
      ? { title: '草稿基线已过期，保存已锁定', body: '服务器文档在这份草稿创建后发生了变化。请先在“差异”中复制需要保留的内容，或载入服务器最新版本。', action: 'server' as const }
      : draftStorageError
        ? { title: '草稿尚未安全落盘', body: draftStorageError }
        : !controller.data.currentRun && dirty
          ? { title: '当前没有可写入的运行', body: '内容会作为本机草稿保留；创建或选择运行后才能保存到规范文档。' }
          : undefined;
  const saveBlocked = !dirty || !selected || !documentContentLoaded || !controller.data.currentRun || Boolean(draftConflict) || controller.working;
  const saveTitle = !documentContentLoaded ? '文档正文尚未加载' : draftConflict ? '服务器版本已变化，请先处理草稿冲突' : !controller.data.currentRun ? '请先选择或创建运行' : '保存文档';
  const onEditorModeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'edit' : 'diff';
    setEditorMode(next);
    requestAnimationFrame(() => event.currentTarget.querySelector<HTMLElement>(`[data-editor-mode="${next}"]`)?.focus());
  };

  return (
    <main className="ide-view">
      <aside className="file-explorer">
        <div className="panel-heading"><span>资源管理器</span><ChevronDown size={15} /></div>
        <div className="tree-root"><Folder size={16} /><strong>{controller.data.currentProject?.name ?? 'project'}</strong></div>
        <div className="tree-folder"><span><ChevronDown size={14} /><Folder size={15} />docs</span>
          <div>{controller.data.documents.map((doc) => <button key={doc.id} className={doc.id === selected?.id ? 'active' : ''} onClick={() => selectDocument(doc.id)}><FileText size={14} /><span>{doc.filename.replace('docs/', '')}</span><i className={doc.status} /></button>)}</div>
        </div>
        <div className="tree-folder collapsed"><span><ChevronRight size={14} /><Folder size={15} />apps</span></div>
        <div className="tree-folder collapsed"><span><ChevronRight size={14} /><Folder size={15} />packages</span></div>
      </aside>
      <section className="editor-region" aria-busy={documentLoading} style={editorNotice ? { gridTemplateRows: '42px auto minmax(260px, 1fr) 188px' } : undefined}>
        <div className="editor-tabs"><div className="active"><FileCode2 size={14} /><span className="desktop-doc-name">{selected?.filename.replace('docs/', '') ?? '未选择'}</span><select className="mobile-doc-select" aria-label="选择 Markdown 文档" value={selected?.id ?? ''} onChange={(event) => selectDocument(event.target.value)}>{controller.data.documents.map((document) => <option key={document.id} value={document.id}>{document.filename.replace('docs/', '')}</option>)}</select>{dirty ? <i /> : null}{draftSaved ? <small>草稿已保存在本机</small> : null}<button className="icon-button mobile-only" aria-label="打开 Agent 与任务检查器" onClick={() => setMobileInspectorOpen(true)}><PanelRightOpen size={16} /></button></div><div className="editor-mode-toggle" role="tablist" aria-label="编辑器模式" onKeyDown={onEditorModeKeyDown}><button id="editor-tab-edit" data-editor-mode="edit" className={editorMode === 'edit' ? 'active' : ''} role="tab" tabIndex={editorMode === 'edit' ? 0 : -1} aria-selected={editorMode === 'edit'} aria-controls="editor-mode-panel" onClick={() => setEditorMode('edit')}><Pencil size={13} />编辑</button><button id="editor-tab-diff" data-editor-mode="diff" className={editorMode === 'diff' ? 'active' : ''} role="tab" tabIndex={editorMode === 'diff' ? 0 : -1} aria-selected={editorMode === 'diff'} aria-controls="editor-mode-panel" onClick={() => setEditorMode('diff')}><Columns2 size={13} />差异</button></div><button className="icon-button" aria-label="保存文档" title={saveTitle} disabled={saveBlocked} onClick={() => void save()}><Save size={16} /></button></div>
        {editorNotice ? <div className="pause-callout" role={documentLoading ? 'status' : 'alert'} style={{ marginTop: 0 }}><strong>{editorNotice.title}</strong><p>{editorNotice.body}</p>{editorNotice.action === 'server' ? <button className="button secondary compact" onClick={useServerVersion}>载入服务器版本</button> : editorNotice.action === 'retry' ? <button className="button secondary compact" onClick={() => setDocumentLoadAttempt((current) => current + 1)}>重试加载</button> : null}</div> : null}
        {editorMode === 'edit' ? <div id="editor-mode-panel" role="tabpanel" aria-labelledby="editor-tab-edit" className="editor-main"><div className="line-numbers" ref={lineNumbersRef} aria-hidden>{Array.from({ length: Math.max(30, content.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea value={content} disabled={!documentContentLoaded} onChange={(event) => updateContent(event.target.value)} onScroll={(event) => { if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = event.currentTarget.scrollTop; }} spellCheck={false} aria-label="Markdown 编辑器" /></div> : <div id="editor-mode-panel" role="tabpanel" aria-labelledby="editor-tab-diff" className="document-diff" aria-label="Markdown 未保存差异">{dirty ? diff.map((line, index) => <div className={`diff-line ${line.type}`} key={`${line.type}-${line.oldLine ?? 'n'}-${line.newLine ?? 'n'}-${index}`}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><b aria-hidden>{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : line.type === 'omitted' ? '…' : ' '}</b><code>{line.content || ' '}</code></div>) : <div className="diff-empty"><Columns2 size={22} /><strong>{documentContentLoaded ? '没有未保存差异' : '正文尚未加载'}</strong><span>{documentContentLoaded ? '编辑内容后，这里会对比已保存版本。' : '正文加载完成后才能查看草稿差异。'}</span></div>}</div>}
        <div className="terminal-panel"><div className="terminal-head"><div><TerminalSquare size={15} /><strong>运行事件</strong></div><span>{controller.connectionState} · readonly</span></div><pre>{events.length ? events.join('\n') : 'Loop 事件流已连接。等待任务或审批事件…'}</pre></div>
      </section>
      <aside className="ide-inspector">
        <div className="panel-heading"><span>Agent / 任务</span><span>{controller.data.agents.length}</span></div>
        <div className="ide-agent-tree">{controller.data.agents.length ? controller.data.agents.map((agent) => <div key={agent.id} style={{ marginLeft: agent.depth * 14 }}><span className={`agent-status ${agent.status}`} /><div><strong>{agent.name}</strong><small>{agent.providerId} · ctx {Math.round(agent.contextUsage * 100)}%</small></div></div>) : <p>执行开始后，这里会显示 Agent 血统。</p>}</div>
        <div className="panel-heading task-heading"><span>任务依赖</span><span>{controller.data.tasks.length}</span></div>
        <div className="ide-task-list">{controller.data.tasks.map((task) => <div key={task.id}><span>{task.id}</span><strong>{task.title}</strong><small>{task.status}</small></div>)}</div>
      </aside>
      {mobileInspectorOpen ? <MobileInspectorDrawer controller={controller} onEditDocument={(document) => selectDocument(document.id)} onClose={() => setMobileInspectorOpen(false)} /> : null}
    </main>
  );
}

function loadDrafts(): Record<string, DocumentDraft> {
  if (typeof localStorage === 'undefined') return {};
  try {
    return parseDocumentDrafts(localStorage.getItem(DRAFT_STORAGE_KEY));
  } catch {
    return {};
  }
}

function storeDrafts(drafts: Record<string, DocumentDraft>): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}
