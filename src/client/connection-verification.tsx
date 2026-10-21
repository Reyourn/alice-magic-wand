import type { LoginAttempt, RuntimeTokenUsage, VerifiedCapability } from '../shared/types.js';

/** Metering is observed independently; an absent counter does not disable working tools. */
export const defaultVerificationCapabilities: VerifiedCapability[] = ['inference', 'streaming', 'tools'];

export function loginNeedsResolution(state?: LoginAttempt['state']): boolean {
  return !!state && ['starting', 'waiting', 'stopping', 'unknown'].includes(state);
}

/** A root PID that vanished without a tree receipt cannot be cleared by retrying in this process. */
export function loginNeedsRestart(attempt?: LoginAttempt): boolean {
  return !!attempt && attempt.state === 'unknown' && attempt.recoveryAction === 'restart-reconcile' && !attempt.recoveryRequired;
}

export function LoginRecoveryNotice({ attempt }: { attempt?: LoginAttempt }) {
  if (!loginNeedsRestart(attempt)) return null;
  return <div className="upgrade-subcard" role="status" aria-label="需要重启后核对">
    <h4>需要重启后核对</h4>
    <p>原生登录的根进程已经退出，但没有拿到整棵进程树停止的回执。当前流程内重复取消不会清除该状态，相关原生连接保持暂停。</p>
    <ol>
      <li>在原生终端和任务管理器核对该次登录的终端及相关进程是否已全部结束。</li>
      <li>按受控方式重启工作台后台：只停止并重启本工作台实例，不要终止其他成员或系统中所有 Node 进程。</li>
      <li>回到接入中心，在本连接的“恢复中断的原生流程”里填写核对依据并勾选确认。</li>
      <li>解除阻塞后重新检查认证，再重新发起调用验证。</li>
    </ol>
    <p className="field-note">人工核对只解除停止阻塞，不代表原生登录成功，也不会自动恢复派发。</p>
  </div>;
}

export function VerificationUsage({ usage }: { usage: RuntimeTokenUsage[] }) {
  const latest = usage.at(-1);
  if (!latest) return <p className="field-note">Token：未提供用量回执；不影响已验证的执行能力，用量保持未知。</p>;
  const count = (value?: number) => value === undefined ? '未提供' : value.toLocaleString('zh-CN');
  return <div className="verification-usage">
    <p>Token：输入 {count(latest.inputTokens)} · 输出 {count(latest.outputTokens)} · 总量 {count(latest.totalTokens)}</p>
    <p className="field-note">最新{latest.scope === 'session' ? '会话累计' : '轮次'}回执{latest.partial ? ' · 部分统计' : ''}；未返回的计数保持未知，不叠加缓存或推理子项。</p>
    {(latest.cachedInputTokens !== undefined || latest.cacheCreationInputTokens !== undefined || latest.reasoningOutputTokens !== undefined) &&
      <p className="field-note">缓存读取 {count(latest.cachedInputTokens)} · 缓存写入 {count(latest.cacheCreationInputTokens)} · 推理 {count(latest.reasoningOutputTokens)}</p>}
  </div>;
}
