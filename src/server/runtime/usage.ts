import type { RuntimeTokenUsage } from '../../shared/types.js';

type NativeUsage = Record<string, unknown>;
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Only these numeric counters may bypass credential-field redaction. */
export function isTokenCountField(key: string, value: unknown): boolean {
  return /^(?:inputTokens|outputTokens|totalTokens|cachedInputTokens|cacheCreationInputTokens|reasoningOutputTokens|cacheWriteInputTokens|cacheReadInputTokens|thinkingTokens|input_tokens|output_tokens|total_tokens|cache_creation_input_tokens|cache_read_input_tokens|prompt_tokens|completion_tokens)$/.test(key)
    && tokenCount(value) !== undefined;
}

export function normalizeUsage(raw: unknown, format: 'codex'|'claude'|'workbuddy', metadata: Pick<RuntimeTokenUsage, 'scope'|'source'|'baselineKnownZero'|'partial'>): RuntimeTokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const usage = raw as NativeUsage;
  let inputTokens = tokenCount(usage[format === 'codex' ? 'inputTokens' : 'input_tokens']);
  const outputTokens = tokenCount(usage[format === 'codex' ? 'outputTokens' : 'output_tokens']);
  const cachedInputTokens = tokenCount(usage[format === 'codex' ? 'cachedInputTokens' : 'cache_read_input_tokens']);
  const cacheCreationInputTokens = tokenCount(usage[format === 'codex' ? 'cacheWriteInputTokens' : 'cache_creation_input_tokens']);
  const reasoningOutputTokens = format === 'codex' ? tokenCount(usage.reasoningOutputTokens) : undefined;
  // Anthropic reports uncached input separately; Codex/WorkBuddy input already
  // includes cache reads and writes. Cache counters remain subsets after mapping.
  if (format === 'claude' && inputTokens !== undefined) inputTokens += (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined ? tokenCount(inputTokens + outputTokens) : undefined;
  const fields = { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheCreationInputTokens, reasoningOutputTokens };
  if (Object.values(fields).every(value => value === undefined)) return;
  return { ...metadata, ...Object.fromEntries(Object.entries(fields).filter(([,value]) => value !== undefined)) };
}
