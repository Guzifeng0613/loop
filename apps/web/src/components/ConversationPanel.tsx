import { ArrowUp, FileCheck2, LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LoopController } from '../useLoop';
import { UnderstandingCard } from './UnderstandingCard';

export function ConversationPanel({ controller }: { controller: LoopController }) {
  const [text, setText] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [controller.data.messages.length]);

  const submit = async () => {
    const content = text.trim();
    if (!content || controller.working) return;
    setText('');
    await controller.sendMessage(content);
  };

  return (
    <section className="conversation-panel">
      <div className="conversation-head">
        <div><Sparkles size={18} /><div><strong>问题深究</strong><span>事实、假设与未决项会被分开记录</span></div></div>
        <span className="message-count">{controller.data.messages.length} 条记录</span>
      </div>
      <div className="message-feed" ref={feedRef}>
        {controller.data.messages.map((message) => (
          <div key={message.id} className={`message-entry ${message.role}`}>
            <div className="message-meta"><span>{message.role === 'user' ? '你' : 'Lead Main'}</span><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
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
          <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="补充目标、纠正理解，或回答待确认问题…" rows={3}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }} />
          <div className="composer-actions"><span>Ctrl + Enter 发送</span><button className="send-button" onClick={() => void submit()} disabled={!text.trim() || controller.working} aria-label="发送消息">{controller.working ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}</button></div>
        </div>
      </div>
    </section>
  );
}
