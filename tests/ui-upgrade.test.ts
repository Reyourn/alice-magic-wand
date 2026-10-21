import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/shared/types.js';
import type { WorkflowNode } from '../src/shared/workflows.js';
import { affectedPlanNodes, arrangeNodes, buildWorkflowTemplate, createsCycle, layoutDirection } from '../src/client/workflow-canvas.js';
import { parseCsvPreview } from '../src/client/artifact-content.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewContent } from '../src/client/artifact-explorer.js';
import { canPrepareDelivery, deliveryActionInput, DeliveryActionCard } from '../src/client/delivery-actions.js';
import type { DeliveryAction } from '../src/shared/delivery.js';
import type { WorkflowDetail } from '../src/shared/types.js';

const task = (id: string, dependencies: string[] = []): WorkflowNode => ({ id, title: id, description: '', acceptance: '', kind: 'task', dependencies: dependencies.map(nodeId => ({ nodeId, kind: 'accepted' })), requiredCapabilities: [], inputs: [], checks: [] });

describe('workflow canvas planning guards', () => {
  it('rejects a cycle through a parallel join while allowing an independent dependency', () => {
    const nodes = [task('input'), task('left', ['input']), task('right', ['input']), task('review', ['left', 'right']), task('separate')];
    expect(createsCycle(nodes, 'review', 'input')).toBe(true);
    expect(createsCycle(nodes, 'review', 'left')).toBe(true);
    expect(createsCycle(nodes, 'left', 'left')).toBe(true);
    expect(createsCycle(nodes, 'separate', 'review')).toBe(false);
    expect(createsCycle(nodes, 'left', 'right')).toBe(false);
  });
  it('lays out a fork and join without changing task identity, execution or dependencies', () => {
    const nodes = [task('input'), task('left', ['input']), task('right', ['input']), task('review', ['left', 'right'])];
    const before = JSON.stringify(nodes);
    const layout = arrangeNodes(nodes);
    expect(Object.keys(layout).sort()).toEqual(['input', 'left', 'review', 'right']);
    expect(layout.input!.x).toBeLessThan(layout.left!.x);
    expect(layout.left!.x).toBeLessThan(layout.review!.x);
    expect(layout.left!.y).not.toBe(layout.right!.y);
    expect(JSON.stringify(nodes)).toBe(before);
    expect(arrangeNodes([])).toEqual({});
    const vertical = arrangeNodes(nodes, 'TB');
    expect(vertical.input!.y).toBeLessThan(vertical.left!.y);
    expect(vertical.left!.y).toBeLessThan(vertical.review!.y);
    expect(JSON.stringify(nodes)).toBe(before);
  });
  it('creates executable checks and a distinct read-only reviewer without inferring authority from a role name', () => {
    const agents = [
      { id: 'lead', memberKind: 'controller', permissionMode: 'read-only' },
      { id: 'writer', memberKind: 'worker', role: 'controller', permissionMode: 'workspace-write' },
      { id: 'reviewer', memberKind: 'worker', permissionMode: 'read-only' },
    ] as Agent[];
    for (const template of ['development', 'analysis', 'design']) {
      const nodes = buildWorkflowTemplate(template, agents);
      expect(nodes.filter(node => node.kind === 'task').every(node => node.checks.length > 0 && node.agentId === 'writer')).toBe(true);
      const review = nodes.find(node => node.kind === 'review')!;
      expect(review.agentId).toBe('reviewer');
      expect(review.dependencies.every(dep => dep.kind === 'candidate')).toBe(true);
      expect(nodes.find(node => node.id === review.dependencies[0]?.nodeId)?.checks.some(check => check.kind === 'review')).toBe(true);
      expect(nodes.some(node => node.dependencies.some(dep => createsCycle(nodes, dep.nodeId, node.id)))).toBe(false);
    }
    expect(buildWorkflowTemplate('development', [agents[1]!]).find(node => node.kind === 'review')?.agentId).toBeUndefined();
  });
  it('shows changed tasks and downstream effects while ignoring layout-only edits', () => {
    const before = [task('input'), task('analysis', ['input']), task('report', ['analysis']), task('separate')];
    const changed = before.map(node => node.id === 'analysis' ? { ...node, agentId: 'other' } : node);
    expect(affectedPlanNodes(before, changed)).toEqual(['analysis', 'report']);
    expect(affectedPlanNodes(before, structuredClone(before))).toEqual([]);
  });
  it('keeps saved graph orientation when opening it in a different desktop width', () => {
    const nodes = [task('input'), task('analysis', ['input']), task('review', ['analysis'])];
    expect(layoutDirection(nodes, arrangeNodes(nodes, 'TB'), 'LR')).toBe('TB');
    expect(layoutDirection(nodes, arrangeNodes(nodes, 'LR'), 'TB')).toBe('LR');
    expect(layoutDirection(nodes, {}, 'TB')).toBe('TB');
    expect(layoutDirection([], {}, 'LR')).toBe('LR');
  });
});

describe('artifact table fidelity', () => {
  it('preserves identifiers, explicit empty cells, quoted commas, multiline cells and escaped quotes', () => {
    expect(parseCsvPreview('号码,内容,零,空\r\n000123,"a,b\nc""d",0,\r\n').rows).toEqual([
      ['号码', '内容', '零', '空'], ['000123', 'a,b\nc"d', '0', ''],
    ]);
    expect(parseCsvPreview('a\nb\nc', 2)).toEqual({ rows: [['a'], ['b']], truncated: true });
  });
  it('distinguishes extracted document content from converted visual PDF while preserving the editable download', () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:4310' } });
    try {
      const extracted = renderToStaticMarkup(createElement(PreviewContent, { preview: { kind: 'document', title: '报告.pptx', text: '已提取正文', downloadUrl: '/api/original' } }));
      expect(extracted).toContain('已提取正文'); expect(extracted).toContain('内容提取预览'); expect(extracted).not.toContain('<iframe'); expect(extracted).toContain('http://127.0.0.1:4310/api/original');
      const converted = renderToStaticMarkup(createElement(PreviewContent, { preview: { kind: 'pdf', title: '报告.pptx', url: 'http://127.0.0.1:4322/converted.pdf', downloadUrl: '/api/original', detail: '转换器逐页视觉预览' } }));
      expect(converted).toContain('<iframe'); expect(converted).toContain('http://127.0.0.1:4322/converted.pdf'); expect(converted).toContain('http://127.0.0.1:4310/api/original');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('mutation retry identity', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('survives reload without persisting API keys, message bodies, attachment bytes or control tokens', async () => {
    const records = new Map<string, string>();
    vi.stubGlobal('localStorage', { get length() { return records.size; }, key: (index: number) => [...records.keys()][index] ?? null, getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value), removeItem: (key: string) => records.delete(key) });
    const keys: string[] = []; let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith('/bootstrap')) return new Response(JSON.stringify({ token: 'secret-control-token' }));
      keys.push((options?.headers as Record<string, string>)['Idempotency-Key']!);
      if (++attempt === 1) throw new TypeError('lost response');
      return new Response(JSON.stringify({ id: 'original-connection' }));
    }));
    const body = { apiKey: 'super-secret-api-key', text: 'private-message-body', data: 'private-attachment-bytes' };
    await expect((await import('../src/client/api.js')).mutate('/api/connections', body)).rejects.toThrow('尚不能确认');
    const saved = JSON.stringify([...records]);
    for (const privateValue of [...Object.values(body), '/api/connections', 'secret-control-token']) expect(saved).not.toContain(privateValue);
    expect(records.size).toBe(1);
    vi.resetModules();
    await expect((await import('../src/client/api.js')).mutate('/api/connections', body)).resolves.toEqual({ id: 'original-connection' });
    expect(keys[0]).toBe(keys[1]); expect(records.size).toBe(0);
  });
  it('keeps an old unresolved identity and blocks silent replacement after the review boundary', async () => {
    const key = crypto.randomUUID(); const records = new Map<string, string>();
    vi.stubGlobal('localStorage', { get length() { return records.size; }, key: (index: number) => [...records.keys()][index] ?? null, getItem: (id: string) => records.get(id) ?? JSON.stringify({ key, createdAt: Date.now() - 31 * 86400000 }), setItem: (id: string, value: string) => records.set(id, value), removeItem: (id: string) => records.delete(id) });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect((await import('../src/client/api.js')).mutate('/api/workflows/w/confirm', { version: 1 })).rejects.toThrow('超过 30 天');
    expect(fetcher).not.toHaveBeenCalled(); expect(records.size).toBe(0);
  });
  it('retains the original request identifier after a lost receipt and uncertain 409', async () => {
    const keys: string[] = []; let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith('/bootstrap')) return new Response(JSON.stringify({ token: 'test-control' }));
      keys.push((options?.headers as Record<string, string>)['Idempotency-Key']!); attempt++;
      if (attempt === 1) throw new TypeError('network closed after send');
      return new Response(JSON.stringify(attempt === 2 ? { error: '投递结果不确定' } : { id: 'original' }), { status: attempt === 2 ? 409 : 200 });
    }));
    const { mutate } = await import('../src/client/api.js');
    await expect(mutate('/api/workflows/w/confirm', { version: 1 })).rejects.toThrow('尚不能确认');
    await expect(mutate('/api/workflows/w/confirm', { version: 1 })).rejects.toThrow('不确定');
    await expect(mutate('/api/workflows/w/confirm', { version: 1 })).resolves.toEqual({ id: 'original' });
    expect(new Set(keys).size).toBe(1);
  });
  it('does not treat a malformed success body as a confirmed operation', async () => {
    const keys: string[] = []; let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith('/bootstrap')) return new Response(JSON.stringify({ token: 'test-control' }));
      keys.push((options?.headers as Record<string, string>)['Idempotency-Key']!);
      return new Response(++attempt === 1 ? 'truncated' : JSON.stringify({ ok: true }));
    }));
    const { mutate } = await import('../src/client/api.js');
    await expect(mutate('/api/workflows/w/draft', { baseVersion: 1 })).rejects.toThrow('回执不完整');
    await expect(mutate('/api/workflows/w/draft', { baseVersion: 1 })).resolves.toEqual({ ok: true });
    expect(keys[0]).toBe(keys[1]);
  });
  it('starts a new attempt only when the backend explicitly proves a rejection had no side effects', async () => {
    const keys: string[] = []; let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith('/bootstrap')) return new Response(JSON.stringify({ token: 'test-control' }));
      keys.push((options?.headers as Record<string, string>)['Idempotency-Key']!);
      return ++attempt === 1 ? new Response(JSON.stringify({ error: '连接尚未验证', retrySafe: true }), { status: 409 }) : new Response(JSON.stringify({ ok: true }));
    }));
    const { mutate } = await import('../src/client/api.js');
    await expect(mutate('/api/workflows/w/confirm', { version: 1 })).rejects.toThrow('尚未验证');
    await expect(mutate('/api/workflows/w/confirm', { version: 1 })).resolves.toEqual({ ok: true });
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('explicit outbound delivery contracts', () => {
  it('requires accepted work and a tested integration version, preserving PR body newlines and fixed argument boundaries', () => {
    const detail = { workflow: { status: 'running' }, integration: { state: 'verified', integratedBundleIds: ['bundle'] }, nodes: [{ accepted: true, bundle: { id: 'bundle', kind: 'code' } }] } as WorkflowDetail;
    expect(canPrepareDelivery(detail)).toBe(false);
    detail.workflow.status = 'completed'; expect(canPrepareDelivery(detail)).toBe(true);
    detail.nodes[0]!.accepted = false; expect(canPrepareDelivery(detail)).toBe(false);
    detail.nodes[0]!.accepted = true; detail.integration!.integratedBundleIds = []; expect(canPrepareDelivery(detail)).toBe(false);
    detail.integration!.integratedBundleIds = ['bundle']; expect(canPrepareDelivery(detail)).toBe(true);
    detail.integration!.state = 'unknown'; expect(canPrepareDelivery(detail)).toBe(false);
    const values = new FormData(); for (const [key, value] of Object.entries({ remote: 'origin', branch: 'feature/report', base: 'main', title: '交付候选', body: '第一行\n\n第二行 $(literal)', draft: 'on' })) values.set(key, value);
    expect(deliveryActionInput('pull-request', values)).toMatchObject({ draft: true, body: '第一行\n\n第二行 $(literal)', branch: 'feature/report' });
    values.set('command', 'deploy-tool'); values.set('args', '["--name","name with spaces","$(literal)"]');
    expect(deliveryActionInput('deploy', values).args).toEqual(['--name', 'name with spaces', '$(literal)']);
    values.set('args', '{"not":"array"}'); expect(() => deliveryActionInput('deploy', values)).toThrow('字符串数组');
  });
  it('makes prepared execution opt-in and unknown/failed records non-repeatable', () => {
    const record: DeliveryAction = { id: 'action', workflowId: 'w', projectId: 'p', kind: 'push', commit: 'a'.repeat(40), worktree: 'D:\\isolated\\integration', fingerprint: 'fixed-fingerprint', createdAt: '2026-10-19T00:00:00Z', state: 'prepared', input: { kind: 'push', remote: 'origin', branch: 'feature/report' }, commands: [{ command: 'git', args: ['push', 'origin', `${'a'.repeat(40)}:refs/heads/feature/report`] }], receipts: [] };
    record.destination = 'https://example.invalid/team/repo.git';
    const render = () => renderToStaticMarkup(createElement(DeliveryActionCard, { record, currentCommit: record.commit, ready: true, blocked: false, refresh: () => {} }));
    expect(render()).toContain('https://example.invalid/team/repo.git');
    expect(render()).toMatch(/<button[^>]+disabled=""[^>]*>确认执行推送提交<\/button>/);
    record.state = 'unknown'; expect(render()).toContain('记录人工核对结论'); expect(render()).not.toContain('确认执行推送提交');
    record.state = 'failed'; expect(render()).not.toContain('确认执行推送提交'); expect(render()).toContain('已核对失败');
  });
});
