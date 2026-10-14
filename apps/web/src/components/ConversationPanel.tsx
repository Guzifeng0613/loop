import { ArrowUp, FileCheck2, LoaderCircle, MessageSquareText, PanelRightOpen, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LoopController } from '../useLoop';
import { UnderstandingCard } from './UnderstandingCard';

export function ConversationPanel({ controller, onOpenInspector }: { controller: LoopController; onOpenInspector: () => void }) {
  const [text, setText] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  // Follow new/streaming messages only when the reader is already near the end.
  // This keeps the live transcript responsive without pulling the user away
  // from an older message they are inspecting.
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    if (distanceFromBottom <= 96) feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
  }, [controller.data.messages]);

  const submit = async () => {
    const content = text.trim();
    if (!content || controller.working) return;
    setText('');
    await controller.sendMessage(content);
  };

  return (
    <section className="conversation-panel">
      <div className="conversation-head">
        <div><span className="conversation-symbol"><Sparkles size={17} /></span><div><strong>问题深究</strong><span>事实、假设与未决项分别记录</span></div></div>
        <div className="conversation-head-actions"><span className="message-count">{controller.data.messages.length} 条记录</span><button className="icon-button mobile-only" aria-label="打开运行检查器" onClick={onOpenInspector}><PanelRightOpen size={17} /></button></div>
      </div>
      <div className="message-feed" ref={feedRef} aria-live="polite" aria-relevant="additions text">
        {!controller.data.messages.length ? <div className="conversation-empty"><MessageSquareText size={28} /><strong>从一个清晰问题开始</strong><p>描述目标、当前状态和限制。Lead Main 会先形成结构化理解，再进入执行。</p></div> : null}
        {controller.data.messages.map((message) => (
          <div key={message.id} className={`message-entry ${message.role}`}>
            <div className="message-meta"><span className="message-author">{message.role === 'user' ? '你' : 'Lead Main'}</span><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
            {message.analysis ? <UnderstandingCard analysis={message.analysis} /> : <div className="message-body">{message.content}</div>}
          </div>
        ))}
      </div>
      <div className="composer-wrap">
        {controller.data.currentRun?.state === 'doc_review' ? (
          <div className="approval-nudge">
            <div><FileCheck2 size={17} /><span><strong>理解已形成文档草案</strong>确认右侧文档后才会拆分任务。</span></div>
            <button className="button primary compact" onClick={() => void controller.approveDocs()} disabled={controller.working}>批准规范</button>
          </div>
        ) : null}
        <div className="composer">
          <textarea aria-label="消息内容" value={text} onChange={(event) => setText(event.target.value)} placeholder="补充目标、纠正理解，或回答待确认问题…" rows={3}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }} />
          <div className="composer-actions"><span>Ctrl + Enter 发送</span><button className="send-button" onClick={() => void submit()} disabled={!text.trim() || controller.working} aria-label="发送消息">{controller.working ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}</button></div>
        </div>
      </div>
    </section>
  );
}
