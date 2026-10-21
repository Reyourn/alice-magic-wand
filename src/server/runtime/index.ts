import type { RuntimeAdapter, RuntimeKind } from '../../shared/types.js';
import { codexAdapter } from './codex.js';
import { claudeAdapter } from './claude.js';
import { createWorkbuddyAdapter } from './workbuddy.js';

export function createAdapters(): Record<RuntimeKind, RuntimeAdapter> {
  return { codex: codexAdapter, claude: claudeAdapter, workbuddy: createWorkbuddyAdapter() };
}
