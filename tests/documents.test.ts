import { describe, expect, it } from 'vitest';
import { hashContent } from '../apps/server/src/documents.js';

describe('document hashing', () => {
  it('normalizes line endings and trailing whitespace', () => {
    expect(hashContent('# Spec\r\n\r\nContent\r\n')).toBe(hashContent('# Spec\n\nContent'));
  });

  it('changes when normative content changes', () => {
    expect(hashContent('# Spec\nA')).not.toBe(hashContent('# Spec\nB'));
  });
});

