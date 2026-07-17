import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CredentialStore } from '../apps/server/src/credentials.js';
import { DocumentService } from '../apps/server/src/documents.js';
import { Orchestrator } from '../apps/server/src/orchestrator.js';
import { ProviderRegistry } from '../apps/server/src/providers.js';
import { runProcess } from '../apps/server/src/security.js';
import { LoopStore } from '../apps/server/src/store.js';
import { WorktreeManager } from '../apps/server/src/worktrees.js';

const temporaryPaths: string[] = [];
const stores: LoopStore[] = [];
afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 35_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for orchestrator');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

describe('multi-agent orchestrator', () => {
  it('decomposes an approved local run, integrates exact artifacts and waits for user acceptance', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'loop-project-'));
    const worktreesRoot = await mkdtemp(resolve(tmpdir(), 'loop-worktrees-'));
    temporaryPaths.push(root, worktreesRoot);
    await mkdir(resolve(root, 'docs'));
    for (const [filename, id] of [
      ['总体方案.md', 'architecture'], ['功能.md', 'features'], ['UI.md', 'ui'], ['API接口.md', 'api'], ['版本更迭.md', 'roadmap']
    ]) {
      await writeFile(resolve(root, 'docs', filename), `---\nloop_schema: 1\ndoc_id: ${id}\nversion: 0.1.0\nstatus: approved\n---\n\n# ${id}\n`, 'utf8');
    }
    await writeFile(resolve(root, 'package.json'), JSON.stringify({
      name: 'loop-fixture', private: true,
      scripts: {
        test: 'node -e "process.exit(0)"',
        typecheck: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(0)"'
      }
    }), 'utf8');
    expect((await runProcess('git init', root)).code).toBe(0);
    await runProcess("git config user.email 'loop@example.local'", root);
    await runProcess("git config user.name 'Loop Test'", root);
    await runProcess('git add -A', root);
    expect((await runProcess("git commit -m 'fixture'", root)).code).toBe(0);

    const store = new LoopStore(':memory:');
    stores.push(store);
    store.setSetting('app', { ...store.getSetting('app')!, concurrency: 2 });
    const project = store.createProject({ name: 'fixture', rootPath: root, isGit: true });
    const documents = new DocumentService(store);
    await documents.syncProject(project.id, root);
    const run = store.createRun({
      projectId: project.id,
      title: 'fixture run',
      question: 'validate orchestration',
      modelMode: 'fixed',
      executionMode: 'multi_agent',
      providerId: 'local-demo',
      model: 'local-structured-demo'
    });
    const orchestrator = new Orchestrator(
      store,
      documents,
      new ProviderRegistry(new CredentialStore()),
      new WorktreeManager(worktreesRoot)
    );
    await orchestrator.approveAllDocuments(run.id);

    await orchestrator.execute(run.id);
    await waitFor(() => ['awaiting_acceptance', 'failed', 'paused'].includes(store.getRun(run.id)?.state ?? ''));
    expect(store.getRun(run.id)?.state, store.getRun(run.id)?.pauseReason).toBe('paused');
    const verificationApproval = store.listApprovals(run.id).find((approval) => approval.tool === 'integration_verification');
    expect(verificationApproval?.reusable).toBe(false);
    store.resolveApproval(verificationApproval!.id, 'approved', 'once');
    store.updateRun(run.id, { state: 'integrating', previousState: 'paused', blocker: null, pauseReason: null });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await orchestrator.integrate(run.id);
    expect(store.getRun(run.id)?.state, store.getRun(run.id)?.pauseReason).toBe('awaiting_acceptance');

    const tasks = store.listTasks(run.id);
    const agents = store.listAgents(run.id);
    expect(tasks).toHaveLength(5);
    expect(tasks.every((task) => task.status === 'completed')).toBe(true);
    expect(agents.filter((agent) => agent.role === 'module-main')).toHaveLength(5);
    expect(store.listApprovals(run.id).some((approval) => approval.tool === 'integration_verification')).toBe(true);
    expect(store.getDeliverySummary(run.id)?.taskResults).toHaveLength(5);
    await orchestrator.acceptDelivery(run.id, 'accept_keep_branch');
    expect(store.getRun(run.id)?.state).toBe('completed');
  }, 50_000);
});
