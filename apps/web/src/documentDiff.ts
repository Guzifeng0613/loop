export interface DocumentDiffLine {
  type: 'context' | 'added' | 'removed' | 'omitted';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export function buildDocumentDiff(saved: string, draft: string): DocumentDiffLine[] {
  const before = saved.split('\n');
  const after = draft.split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix += 1;

  const lines: DocumentDiffLine[] = [];
  const contextSize = 3;
  const prefixStart = Math.max(0, prefix - contextSize);
  if (prefixStart > 0) lines.push({ type: 'omitted', content: `… ${prefixStart} 行未变化 …` });
  for (let index = prefixStart; index < prefix; index += 1) {
    lines.push({ type: 'context', content: before[index] ?? '', oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = prefix; index < before.length - suffix; index += 1) {
    lines.push({ type: 'removed', content: before[index] ?? '', oldLine: index + 1 });
  }
  for (let index = prefix; index < after.length - suffix; index += 1) {
    lines.push({ type: 'added', content: after[index] ?? '', newLine: index + 1 });
  }
  const visibleSuffix = Math.min(suffix, contextSize);
  for (let offset = suffix; offset > suffix - visibleSuffix; offset -= 1) {
    const oldIndex = before.length - offset;
    const newIndex = after.length - offset;
    lines.push({ type: 'context', content: before[oldIndex] ?? '', oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }
  if (suffix > contextSize) lines.push({ type: 'omitted', content: `… ${suffix - contextSize} 行未变化 …` });
  return lines;
}
