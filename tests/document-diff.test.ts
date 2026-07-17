import { describe, expect, it } from 'vitest';
import { buildDocumentDiff } from '../apps/web/src/documentDiff.js';

describe('Markdown document diff', () => {
  it('keeps line numbers while separating removed and added content', () => {
    const diff = buildDocumentDiff('# Spec\nold\nshared', '# Spec\nnew\nshared');
    expect(diff).toEqual([
      { type: 'context', content: '# Spec', oldLine: 1, newLine: 1 },
      { type: 'removed', content: 'old', oldLine: 2 },
      { type: 'added', content: 'new', newLine: 2 },
      { type: 'context', content: 'shared', oldLine: 3, newLine: 3 }
    ]);
  });
});
