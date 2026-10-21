import { spawn } from 'node:child_process';

export interface SecretProtector { protect(value: string): Promise<string>; unprotect(value: string): Promise<string>; }

/** Windows user-bound DPAPI. Plaintext travels only through anonymous pipes. */
export class WindowsDpapiProtector implements SecretProtector {
  async protect(value: string): Promise<string> { return this.transform(value, true); }
  async unprotect(value: string): Promise<string> { return this.transform(value, false); }
  private async transform(value: string, encrypt: boolean): Promise<string> {
    if (process.platform !== 'win32') throw new Error('当前凭据存储仅支持 Windows DPAPI；此平台可沿用原生认证');
    const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ` + (encrypt
      ? '$b=[Text.Encoding]::UTF8.GetBytes($v); $r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))'
      : '$b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))');
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Windows 凭据加密超时')); }, 15_000);
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 128_000) child.kill(); });
      child.stderr.on('data', () => {});
      child.on('error', () => { clearTimeout(timer); reject(new Error('无法调用 Windows 凭据保护服务')); });
      child.on('exit', code => { clearTimeout(timer); if (code === 0 && output) resolve(output); else reject(new Error('Windows 凭据保护失败，请使用保存此凭据的 Windows 用户')); });
      child.stdin.on('error', () => {}); child.stdin.end(value);
    });
  }
}
