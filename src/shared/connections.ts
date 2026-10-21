import type { RuntimeKind, RuntimeModelCatalog, RuntimeTokenUsage } from './types.js';

export type ConnectionMode = 'native' | 'official-api' | 'gateway';
export type WorkbuddyEdition = 'china' | 'international';
export type ConnectionProtocol = 'native' | 'responses' | 'anthropic-messages' | 'openai-chat' | 'codebuddy';
export type ConnectionState = 'unconfigured' | 'not-installed' | 'authentication-observed' | 'verified' | 'authentication-failed' | 'quota-exceeded' | 'model-unavailable' | 'network-failed' | 'conflict' | 'unknown';
export type VerifiedCapability = 'inference' | 'streaming' | 'tools' | 'images' | 'usage';
export interface ConnectionStatus { state: ConnectionState; checkedAt: string; detail: string; credentialSource?: string; provider?: string; }
export interface ConnectionVerification {
  id: string; connectionId: string; revision: number; requestedModel: string; observedModel?: string; observedProvider?: string;
  checkedAt: string; success: boolean; status: ConnectionStatus; capabilities: VerifiedCapability[]; usage: RuntimeTokenUsage[];
  detail: string; nativeSessionId?: string; contextFingerprint?: string;
}
export interface ConnectionProfile {
  id: string; name: string; runtime: RuntimeKind; mode: ConnectionMode; protocol: ConnectionProtocol; provider: string;
  region?: 'china' | 'international' | 'existing'; baseUrl?: string; defaultModel: string; executable?: string;
  /** Desktop distribution, independent of API region. Omitted on legacy connections. */
  workbuddyEdition?: WorkbuddyEdition;
  revision: number; hasCredential: boolean; createdAt: string; updatedAt: string; status?: ConnectionStatus;
  /** Latest metadata-only native auth check; independent of inference verification. */
  authenticationStatus?: ConnectionStatus;
  verifications: ConnectionVerification[]; catalog?: RuntimeModelCatalog;
}
/** Write-only API input. Keys are never returned by a read endpoint. */
export interface ConnectionInput {
  name: string; runtime: RuntimeKind; mode: ConnectionMode; protocol?: ConnectionProtocol; provider?: string;
  region?: ConnectionProfile['region']; baseUrl?: string; defaultModel?: string; executable?: string;
  workbuddyEdition?: WorkbuddyEdition;
  apiKey?: string; clearCredential?: boolean;
}
/** The only two safe next steps for an unconfirmed native stop. */
export type LoginRecoveryAction = 'retry-stop' | 'restart-reconcile';
export interface LoginAttempt {
  id: string; connectionId: string; runtime: RuntimeKind; state: 'starting' | 'waiting' | 'stopping' | 'unknown' | 'completed' | 'cancelled' | 'failed' | 'resolved';
  startedAt: string; updatedAt: string; method: 'browser' | 'device-code' | 'native-terminal';
  authUrl?: string; userCode?: string; detail: string; recoveryRequired?:boolean;
  /** Structured, non-secret next step. Never carries raw process output or credentials. */
  recoveryAction?: LoginRecoveryAction;
}
/** Server-only launch configuration. Never serialize this into events, HTTP or SQLite. */
export interface RuntimeOverrides {
  connectionId: string; revision: number; env: Record<string, string | undefined>; executable?: string;
  workbuddyEdition?: WorkbuddyEdition;
  /** Backend-only, per-process authorization for supported desktop bundles. Never copies native credentials. */
  nativeMemoryAuthentication?:boolean;
  config?: Record<string, unknown>; settingSources?: ('user' | 'project' | 'local')[];
}
export const CONNECTION_INSTALL_URLS: Record<RuntimeKind, string> = {
  codex: 'https://developers.openai.com/codex/cli/',
  claude: 'https://code.claude.com/docs/en/setup',
  workbuddy: 'https://www.codebuddy.cn/docs/cli/installation',
};
