import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewRunPanel } from '../apps/web/src/components/NewRunPanel.js';
import type { LoopController } from '../apps/web/src/useLoop.js';

describe('new run UI', () => {
  it('exposes fixed/auto routing and only configured providers', () => {
    const controller = {
      working: false,
      createRun: vi.fn(),
      data: {
        currentProject: { id: 'project-1', name: 'fixture', rootPath: 'C:\\fixture', isGit: true, createdAt: new Date().toISOString() },
        providers: [
          { id: 'openai', label: 'OpenAI', configured: false, enabled: true, defaultModel: 'gpt-configured-by-user', availableModels: ['gpt-configured-by-user'], supportsTools: true, supportsReasoning: true },
          { id: 'deepseek', label: 'DeepSeek V4', configured: true, enabled: true, defaultModel: 'deepseek-v4-pro', availableModels: ['deepseek-v4-pro'], supportsTools: true, supportsReasoning: true },
          { id: 'local-demo', label: '本地演示', configured: true, enabled: true, defaultModel: 'local-structured-demo', availableModels: ['local-structured-demo'], supportsTools: false, supportsReasoning: false }
        ]
      }
    } as unknown as LoopController;
    const html = renderToStaticMarkup(<NewRunPanel controller={controller} onClose={vi.fn()} />);
    expect(html).toContain('固定模型');
    expect(html).toContain('智能路由');
    expect(html).toContain('DeepSeek V4');
    expect(html).not.toContain('<option value="openai">');
  });
});
