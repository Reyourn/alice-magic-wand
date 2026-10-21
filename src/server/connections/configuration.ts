import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ConnectionInput, ConnectionProfile, RuntimeOverrides } from '../../shared/connections.js';
import { discoverWorkbuddyInstallations, resolveWorkbuddyExecutable, workbuddyEnvironment, bindWorkbuddyProduct } from '../runtime/process.js';

const authVariables = /^(?:OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_HOME|CODEX_API_KEY|CODEX_AUTH_TOKEN|ANTHROPIC_.*|CLAUDE_CODE_USE_.*|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CODEBUDDY_.*|WORKBUDDY_.*|AWB_CONNECTION_KEY)$/i;
const providerOverrides = /(?:api[_-]?key|apiKeyHelper|auth[_-]?token|base[_-]?url|model_provider|model_providers|OPENAI_|ANTHROPIC_|CODEBUDDY_|WORKBUDDY_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN)/i;
const projectConfigNames = (runtime: ConnectionProfile['runtime']): string[] => runtime === 'codex' ? ['.codex/config.toml'] : runtime === 'claude' ? ['.claude/settings.json','.claude/settings.local.json'] : ['.codebuddy/settings.json','.codebuddy/settings.local.json','.codebuddy/models.json'];
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Fingerprint routing inputs without persisting any file contents or credentials.
 * Paths are represented by configuration layer so identical isolated worktrees
 * can reuse proof, while a changed project/global override invalidates it.
 */
export async function connectionContextFingerprint(profile: ConnectionProfile, cwd: string): Promise<string> {
  const layers: Array<[string,string]> = [];
  const add = async (label: string, path: string) => {
    try { layers.push([label, hash(await readFile(path))]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取连接配置，不能确认原有验证仍然有效'); }
  };
  let directory = resolve(cwd), depth = 0;
  for (;;) {
    if (directory.toLowerCase() === resolve(homedir()).toLowerCase()) break;
    for (const name of projectConfigNames(profile.runtime)) await add(`project:${depth}:${name}`,join(directory,name));
    const parent = dirname(directory); if (parent === directory) break; directory = parent; depth++;
  }
  if (profile.mode === 'native') {
    const home = homedir();
    const directories = profile.runtime === 'codex' ? [process.env.CODEX_HOME || join(home,'.codex')]
      : profile.runtime === 'claude' ? [process.env.CLAUDE_CONFIG_DIR || join(home,'.claude')]
      : [process.env.CODEBUDDY_CONFIG_DIR || join(home,'.codebuddy'),process.env.WORKBUDDY_CONFIG_DIR || join(home,'.workbuddy')];
    const names = profile.runtime === 'codex' ? ['config.toml'] : profile.runtime === 'claude' ? ['settings.json','settings.local.json'] : ['settings.json','settings.local.json','models.json'];
    for (let index=0;index<directories.length;index++) for (const name of names) await add(`native:${index}:${name}`,join(directories[index],name));
    for (const [name,value] of Object.entries(process.env).sort(([a],[b])=>a.localeCompare(b))) if (value && authVariables.test(name)) layers.push([`environment:${name.toUpperCase()}`,hash(value)]);
  }
  const resolvedExecutable = profile.runtime === 'workbuddy' ? await resolveWorkbuddyExecutable(profile.executable,profile.workbuddyEdition) : undefined;
  const installation = resolvedExecutable ? (await discoverWorkbuddyInstallations({candidates:[resolvedExecutable]}))[0] : undefined;
  if(installation)await add('native:workbuddy:product',join(dirname(dirname(installation.executable)),'product.json'));
  return hash(JSON.stringify({runtime:profile.runtime,connectionId:profile.id,revision:profile.revision,executable:profile.executable??null,...(profile.runtime === 'workbuddy' ? {workbuddyEdition:profile.workbuddyEdition??null,resolvedExecutable:resolvedExecutable??null,installation} : {}),layers}));
}
export function normalizeConnection(input: ConnectionInput): Omit<ConnectionProfile, 'id'|'revision'|'createdAt'|'updatedAt'|'hasCredential'|'verifications'> {
  if (!['codex','claude','workbuddy'].includes(input.runtime)) throw new Error('未知执行工具');
  if (!['native','official-api','gateway'].includes(input.mode)) throw new Error('未知连接方式');
  const name = input.name?.trim(); if (!name || name.length > 120) throw new Error('连接名称需要 1–120 个字符');
  if (input.executable && (!isAbsolute(input.executable) || /[\r\n\0]/.test(input.executable))) throw new Error('执行程序必须是本机绝对路径');
  if (input.workbuddyEdition !== undefined && (input.runtime !== 'workbuddy' || !['china','international'].includes(input.workbuddyEdition))) throw new Error('国内／国际版本仅适用于 WorkBuddy，请选择有效的发行版');
  let protocol = input.protocol ?? (input.mode === 'native' ? 'native' : input.runtime === 'codex' ? 'responses' : input.runtime === 'claude' ? 'anthropic-messages' : 'codebuddy');
  if (input.mode === 'native') protocol = 'native';
  const allowed = input.runtime === 'codex' ? ['responses'] : input.runtime === 'claude' ? ['anthropic-messages'] : ['codebuddy','anthropic-messages','openai-chat'];
  if (input.mode !== 'native' && !allowed.includes(protocol)) throw new Error('所选协议不受此执行工具支持');
  if (input.mode === 'official-api' && protocol !== (input.runtime === 'codex' ? 'responses' : input.runtime === 'claude' ? 'anthropic-messages' : 'codebuddy')) throw new Error('官方 API 必须采用该工具的官方协议');
  const region = input.runtime === 'workbuddy' ? input.region ?? 'china' : undefined;
  if (region === 'existing' && input.mode !== 'native') throw new Error('已有企业环境请沿用原生配置；新 API 连接请选择中国站、国际站或兼容网关');
  const defaults = input.runtime === 'codex' ? 'https://api.openai.com/v1' : input.runtime === 'claude' ? 'https://api.anthropic.com' : undefined;
  const rawUrl = input.mode === 'native' ? undefined : input.baseUrl?.trim() || (input.mode === 'official-api' ? defaults : undefined);
  if (input.mode === 'gateway' && !rawUrl) throw new Error('兼容网关需要服务地址');
  let baseUrl: string | undefined;
  if (rawUrl) { let url: URL; try { url = new URL(rawUrl); } catch { throw new Error('服务地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址仅支持不含账号、查询参数的 HTTP(S) URL');
    if (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('远程服务地址必须使用 HTTPS');
    baseUrl = url.toString().replace(/\/$/, '');
  }
  if (input.mode === 'official-api' && defaults && baseUrl !== defaults) throw new Error('自定义服务地址请使用兼容网关连接');
  if (input.mode === 'official-api' && input.runtime === 'workbuddy' && baseUrl) throw new Error('CodeBuddy 官方 API 由中国站／国际站选择端点；自定义地址请使用兼容网关');
  return { name, runtime: input.runtime, mode: input.mode, protocol, provider: input.provider?.trim() || (input.mode === 'native' ? '原生配置' : input.mode === 'gateway' ? '兼容网关' : {codex:'OpenAI',claude:'Anthropic',workbuddy:'CodeBuddy'}[input.runtime]), region, baseUrl, defaultModel: input.defaultModel?.trim() ?? '', executable: input.executable || undefined, ...(input.workbuddyEdition ? {workbuddyEdition:input.workbuddyEdition} : {}) };
}
/** Project routing wins over some native command-line settings. Fail closed instead of guessing. */
export async function routingConflicts(profile: ConnectionProfile, cwd: string): Promise<string[]> {
  if (profile.mode === 'native') return [];
  const found: string[] = []; let directory = resolve(cwd);
  for (;;) {
    // Home-level files are the global configuration replaced by the private
    // profile directory, not a project override inherited by this process.
    if (directory.toLowerCase() === resolve(homedir()).toLowerCase()) break;
    const names = projectConfigNames(profile.runtime);
    for (const name of names) { const file = join(directory, name); try { const text = await readFile(file, 'utf8'); if (text.length > 1024 * 1024 || providerOverrides.test(text) || name.endsWith('models.json') && text.trim() !== '{}' && text.trim() !== '[]') found.push(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') found.push(file); } }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  return found;
}
export async function profileOverrides(dataDir: string, profile: ConnectionProfile, key: string | undefined, cwd: string, enableImageProbe = false): Promise<RuntimeOverrides> {
  if (profile.executable) { try { await access(profile.executable); } catch { throw new Error('所选执行程序路径不存在'); } }
  const executable = profile.runtime === 'workbuddy' ? await resolveWorkbuddyExecutable(profile.executable, profile.workbuddyEdition) : profile.executable;
  const conflicts = await routingConflicts(profile, cwd);
  if (conflicts.length) throw new Error(`项目配置可能覆盖所选连接，请先处理：${conflicts.join('；')}`);
  if (profile.mode === 'native') {
    const env=profile.runtime==='workbuddy'&&executable?await bindWorkbuddyProduct(executable,workbuddyEnvironment()):profile.runtime==='workbuddy'?workbuddyEnvironment():{...process.env};
    const installation=profile.runtime==='workbuddy'&&executable?(await discoverWorkbuddyInstallations({candidates:[executable]}))[0]:undefined;
    // API credentials inherited intentionally remain on their existing route.
    const nativeMemoryAuthentication=installation?.cliVersion==='2.161.0'&&installation.executionPackage==='lite'&&!env.CODEBUDDY_API_KEY&&!env.CODEBUDDY_AUTH_TOKEN;
    return {connectionId:profile.id,revision:profile.revision,executable,workbuddyEdition:profile.workbuddyEdition??installation?.edition,env,...(nativeMemoryAuthentication?{nativeMemoryAuthentication:true}:{})};
  }
  if (!key) throw new Error('此连接尚未配置 API Key');
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !authVariables.test(name)));
  const directory = join(dataDir, 'connections', profile.id, `v${profile.revision}`, ...(enableImageProbe ? ['image-probe'] : [])); await mkdir(directory, { recursive: true });
  env.AWB_CONNECTION_KEY = key;
  if (profile.runtime === 'workbuddy') Object.assign(env, workbuddyEnvironment(env));
  const overrides: RuntimeOverrides = {connectionId:profile.id,revision:profile.revision,executable,workbuddyEdition:profile.workbuddyEdition,env,settingSources:[]};
  if (profile.runtime === 'codex') {
    env.CODEX_HOME = directory;
    overrides.config = {model_provider:'workbench',model_providers:{workbench:{name:profile.provider,base_url:profile.baseUrl,env_key:'AWB_CONNECTION_KEY',wire_api:'responses',requires_openai_auth:false}}};
    // model/list and account probes must see the same provider as thread/start.
    const quote = (s: string) => JSON.stringify(s);
    await writeFile(join(directory, 'config.toml'), `model_provider = "workbench"\n[model_providers.workbench]\nname = ${quote(profile.provider)}\nbase_url = ${quote(profile.baseUrl!)}\nenv_key = "AWB_CONNECTION_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n`, 'utf8');
  } else if (profile.runtime === 'claude') {
    env.CLAUDE_CONFIG_DIR = directory; env.ANTHROPIC_API_KEY = key; env.ANTHROPIC_BASE_URL = profile.baseUrl;
  } else {
    env.CODEBUDDY_CONFIG_DIR = directory; env.WORKBUDDY_CONFIG_DIR = directory;
    if (profile.protocol === 'openai-chat') {
      if (!profile.defaultModel) throw new Error('WorkBuddy OpenAI 兼容连接必须填写默认模型 ID');
      // The native registry prefixes entries loaded from models.json. Passing
      // the provider's raw ID can select an unrelated built-in model instead.
      overrides.config = { workbuddyModelId: `custom-local:${profile.defaultModel}` };
      const supportsImages = enableImageProbe || profile.verifications.some(result=>result.revision===profile.revision&&result.success&&[profile.defaultModel,`custom-local:${profile.defaultModel}`].includes(result.requestedModel)&&result.capabilities.includes('images'));
      await writeFile(join(directory, 'models.json'), JSON.stringify({models:[{id:profile.defaultModel,name:profile.defaultModel,url:profile.baseUrl,apiKey:'${AWB_CONNECTION_KEY}',provider:'openai',supportsImages}]}), 'utf8');
    } else {
      env.CODEBUDDY_API_KEY = key;
      if (profile.baseUrl) env.CODEBUDDY_BASE_URL = profile.baseUrl;
      if (profile.defaultModel) env.CODEBUDDY_MODEL = profile.defaultModel;
      if (profile.protocol === 'codebuddy' && profile.region === 'china') env.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';
    }
  }
  return overrides;
}
