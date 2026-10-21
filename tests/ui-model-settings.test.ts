import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, RuntimeModelCatalog } from '../src/shared/types.js';
import { configuredModelSuggestions, modelChangeBlockReason, modelReceiptText, ModelCatalogSelector, ModelSettings } from '../src/client/model-settings.js';
import { readModelCatalog } from '../src/client/api.js';

const agent: Agent = { id: 'member', projectId: 'project', name: '主控', role: 'controller', runtime: 'codex', model: '', instructions: '', permissionMode: 'read-only', controlMode: 'auto', state: 'idle', createdAt: '2026-10-09T00:00:00Z' };

describe('discoverable model settings', () => {
  it('distinguishes native automatic selection from an actual concrete model receipt', () => {
    expect(modelReceiptText(' auto ')).toBe('原生自动选择（未返回具体模型）');
    expect(modelReceiptText('default')).toBe('原生自动选择（未返回具体模型）');
    expect(modelReceiptText(undefined)).toBe('尚无具体模型回执');
    expect(modelReceiptText('gpt-configured-example')).toBe('gpt-configured-example');
  });

  it('only suggests deduplicated explicit configurations for the same runtime', () => {
    const agents: Agent[] = [agent, { ...agent, id: 'one', model: ' local-model ' }, { ...agent, id: 'two', model: 'local-model' }, { ...agent, id: 'three', runtime: 'claude', model: 'different-tool' }, { ...agent, id: 'four', model: '', observedModel: 'observed-only' }];
    expect(configuredModelSuggestions(agents, 'codex')).toEqual(['local-model']);
  });

  it('blocks configuration changes during execution and until unknown state is resolved', () => {
    for (const state of ['starting', 'running', 'waiting_approval', 'interrupting', 'unknown'] as const) expect(modelChangeBlockReason(state)).toBeTruthy();
    for (const state of ['idle', 'offline', 'stopped'] as const) expect(modelChangeBlockReason(state)).toBeUndefined();
    expect(modelChangeBlockReason('unknown')).toContain('核对');
  });

  it('renders both model choices, separate receipt facts, and clear session replacement semantics', () => {
    const html = renderToStaticMarkup(createElement(ModelSettings, { agent: { ...agent, observedModel: 'auto' }, agents: [agent], busy: false, run: async () => true, getError: () => '', onDone: () => {} }));
    expect(html).toContain('使用原生默认');
    expect(html).toContain('指定模型');
    expect(html).toContain('实际回执');
    expect(html).toContain('未返回具体模型');
    expect(html).toContain('旧任务、代码和成果保留');
    expect(html).toContain('保存模型设置');
  });

  it('labels reused identifiers as configured suggestions, not an available-model catalog', () => {
    const configured = { ...agent, model: 'my-model', state: 'running' as const };
    const html = renderToStaticMarkup(createElement(ModelSettings, { agent: configured, agents: [configured], busy: false, run: async () => true, getError: () => '', onDone: () => {} }));
    expect(html).toContain('已配置模型建议');
    expect(html).toContain('并非当前账号可用模型列表');
    expect(html).toContain('请先中断并等待停止');
    expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  });
});

describe('native model catalog', () => {
  afterEach(() => vi.unstubAllGlobals());
  const catalog: RuntimeModelCatalog = { runtime: 'codex', models: [{ id: 'native-id', name: '原生返回模型', description: '原生说明', isDefault: true }], source: 'native/model/list', status: 'ready', checkedAt: '2026-10-09T10:00:00Z', detail: '已读取原生目录' };

  it('fetches the member-scoped catalog and only requests refresh explicitly', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(catalog)));
    vi.stubGlobal('fetch', fetcher);
    await expect(readModelCatalog('member')).resolves.toEqual(catalog);
    const controller = new AbortController();
    await readModelCatalog('member/other', { refresh: true, signal: controller.signal });
    expect(fetcher.mock.calls[0][0]).toBe('/api/agents/member/models');
    expect(fetcher.mock.calls[1][0]).toBe('/api/agents/member%2Fother/models?refresh=1');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ cache: 'no-store', signal: controller.signal });
  });

  it('rejects a response body that arrives after closing or switching the member context', async () => {
    let finishBody!: (value: RuntimeModelCatalog) => void;
    const body = new Promise<RuntimeModelCatalog>(resolve => { finishBody = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => body }));
    const controller = new AbortController();
    const request = readModelCatalog('old-member', { signal: controller.signal });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    finishBody(catalog);
    await rejection;
  });

  it('displays detected source and time without selecting a default model on the user’s behalf', () => {
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(createElement(ModelCatalogSelector, { catalog, loading: false, error: '', selectedModel: 'existing-custom-id', onSelect, onRefresh: () => {} }));
    expect(html).toContain('native/model/list');
    expect(html).toContain('检测时间');
    expect(html).toContain('原生返回模型');
    expect(html).toContain('<option value="" selected="">');
    expect(html).not.toContain('<option value="native-id" selected="">');
    expect(onSelect).not.toHaveBeenCalled();
    expect(html).toContain('不代表当前账号额度');
  });

  it('retains a stale directory with an explicit label when a refresh fails', () => {
    const html = renderToStaticMarkup(createElement(ModelCatalogSelector, { catalog: { ...catalog, stale: true, attemptedAt: '2026-10-09T11:00:00Z' }, loading: false, error: '原生工具暂未连接', selectedModel: 'native-id', onSelect: () => {}, onRefresh: () => {} }));
    expect(html).toContain('检测未完成');
    expect(html).toContain('上次检测到的模型');
    expect(html).toContain('最近尝试');
    expect(html).toContain('原生返回模型');
  });

  it('makes an unavailable or loading catalog honest while preserving custom/default choices', () => {
    const html = renderToStaticMarkup(createElement(ModelCatalogSelector, { catalog: { ...catalog, status: 'unavailable', models: [], detail: '未找到执行工具' }, loading: false, error: '', selectedModel: '', onSelect: () => {}, onRefresh: () => {} }));
    expect(html).toContain('未找到执行工具');
    expect(html).toContain('使用原生默认，或输入自定义标识');
    expect(html).not.toContain('<select');
    const loading = renderToStaticMarkup(createElement(ModelCatalogSelector, { loading: true, error: '', selectedModel: '', onSelect: () => {}, onRefresh: () => {} }));
    expect(loading).toContain('正在读取该成员执行工具的模型目录');
    expect(loading).toMatch(/type="button"[^>]*disabled=""/);
  });

  it('surfaces native catalog errors instead of inventing a fallback directory', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '成员不存在' }), { status: 404 })));
    await expect(readModelCatalog('missing')).rejects.toThrow('成员不存在');
  });
});
