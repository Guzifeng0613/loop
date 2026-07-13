import { Check, CircleHelp, Lightbulb, MessageCircleQuestion } from 'lucide-react';
import type { UnderstandingAnalysis } from '@loop/contracts';

function ListBlock({ title, items, icon: Icon, tone }: { title: string; items: string[]; icon: typeof Check; tone: string }) {
  return (
    <section className={`analysis-block ${tone}`}>
      <div className="analysis-block-title"><span className="analysis-icon"><Icon size={15} /></span><span>{title}</span><b>{items.length}</b></div>
      {items.length ? <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p>当前没有未决项。</p>}
    </section>
  );
}

export function UnderstandingCard({ analysis }: { analysis: UnderstandingAnalysis }) {
  return (
    <article className="understanding-card">
      <div className="understanding-head">
        <div>
          <span>本轮理解快照</span>
          <h3>{analysis.summary}</h3>
        </div>
        <span className={`source-mark ${analysis.source}`}>{analysis.source === 'model' ? '模型分析' : '本地演示'}</span>
      </div>
      <div className="analysis-grid">
        <ListBlock title="已经理解" items={analysis.understood} icon={Check} tone="understood" />
        <ListBlock title="仍未理解" items={analysis.unclear} icon={CircleHelp} tone="unclear" />
        <ListBlock title="当前假设" items={analysis.assumptions} icon={Lightbulb} tone="assumption" />
        <ListBlock title="需要确认" items={analysis.questions} icon={MessageCircleQuestion} tone="question" />
      </div>
    </article>
  );
}
