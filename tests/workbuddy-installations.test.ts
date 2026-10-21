import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionContextFingerprint, normalizeConnection, profileOverrides } from '../src/server/connections/configuration.js';
import { bindWorkbuddyProduct, discoverRuntime, discoverWorkbuddyInstallations, resolveWorkbuddyExecutable, workbuddyEnvironment } from '../src/server/runtime/process.js';
import { discoverRuntimeModels } from '../src/server/runtime/models.js';
import { workbuddyAdapter, workbuddyLaunch } from '../src/server/runtime/workbuddy.js';
import type { ConnectionProfile, WorkbuddyEdition } from '../src/shared/connections.js';
import type { RuntimeEvent } from '../src/shared/types.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(edition: WorkbuddyEdition, name = 'neutral') {
  const directory = await mkdtemp(join(tmpdir(), 'awb-wb-install-')); directories.push(directory);
  const root = join(directory, name), cli = join(root, 'resources/app.asar.unpacked/cli');
  await mkdir(join(cli, 'bin'), { recursive: true });
  await mkdir(join(cli, 'dist'), { recursive: true });
  await writeFile(join(cli, 'package.json'), JSON.stringify({ version: 'unrelated-launcher-version', publishConfig: { customPackage: { version: '2.161.0' } }, privateField: 'do-not-expose-package' }));
  await writeFile(join(cli, 'dist/codebuddy-lite-wb.mjs'), '// Synthetic public artifact; never executed.');
  const executable = join(cli, 'bin/codebuddy');
  const productId = edition === 'china' ? 'workbuddy-desktop' : 'workbuddy-desktop-ai';
  await writeFile(join(cli, 'product.json'), JSON.stringify({ authentication: { id: productId }, privateField: 'do-not-expose-product' }));
  const desktopPath = join(root, edition === 'china' ? 'WorkBuddy.exe' : 'WorkBuddyAI.exe');
  await writeFile(desktopPath, 'synthetic');
  await writeFile(join(root, 'resources/install-manifest.json'), JSON.stringify({ appVersion: '5.8.4' }));
  // A transport double, never a vendor login or a model request. It rejects a missing lite flag.
  await writeFile(executable, `
const readline = require('node:readline');
if (process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE !== '1') process.exit(21);
if (process.argv.includes('--version')) { console.log('2.161.0-synthetic'); process.exit(0); }
let authorized = !process.env.CODEBUDDY_CREDENTIALS_IN_MEMORY;
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line), id = r.request_id;
  if (r.request.subtype === 'authenticate') authorized = true;
  const response = r.request.subtype === 'initialize'
    ? { currentModelId: '${edition}-model', account: authorized ? {token:'private-account-token'} : null, models: [] }
    : r.request.subtype === 'get_auth_methods' ? { methods: [{id:'${productId}'}] }
    : r.request.subtype === 'authenticate' ? {success:true}
    : { availableModels: [{modelId:'${edition}-model',name:'${edition}'}], rawModels: [{id:'${edition}-model',supportsImages:true,apiKey:'private-model-key'}] };
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:id,response}}));
});
`);
  return { directory, root, cli, executable, desktopPath, productId };
}
function profile(executable: string, edition?: WorkbuddyEdition, mode: ConnectionProfile['mode'] = 'native'): ConnectionProfile {
  return { ...normalizeConnection({ name: 'Test', runtime: 'workbuddy', mode, executable, workbuddyEdition: edition }), id: edition ?? 'legacy', revision: 1, createdAt: '', updatedAt: '', hasCredential: false, verifications: [] };
}

describe('WorkBuddy native product binding',()=>{
  it('binds each identified desktop to its own unchanged vendor product file',async()=>{
    const china=await fixture('china'),international=await fixture('international');
    const [chinaProduct,internationalProduct]=await Promise.all([readFile(join(china.cli,'product.json'),'utf8'),readFile(join(international.cli,'product.json'),'utf8')]);
    const environment={CODEBUDDY_CREDENTIALS_IN_MEMORY:'1',CODEBUDDY_FORCE_LITE_WB_BUNDLE:'1',CODEBUDDY_INTERNET_ENVIRONMENT:'internal',CODEBUDDY_DISABLE_PRODUCT_CACHE:'0',CODEBUDDY_REMOTE_CONFIG_DISABLED:'0'};
    const [a,b]=await Promise.all([bindWorkbuddyProduct(china.executable,environment),bindWorkbuddyProduct(international.executable,environment)]);
    expect(a.ACC_PRODUCT_CONFIG_V3).toBe(chinaProduct);
    expect(b.ACC_PRODUCT_CONFIG_V3).toBe(internationalProduct);
    expect(a.ACC_PRODUCT_CONFIG_PATH).toBeUndefined();
    expect(a.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBe('1');
    expect(a.CODEBUDDY_INTERNET_ENVIRONMENT).toBe('internal');
    expect(a.CODEBUDDY_DISABLE_PRODUCT_CACHE).toBe('1');
    expect(b.CODEBUDDY_DISABLE_PRODUCT_CACHE).toBe('1');
    expect(a.CODEBUDDY_REMOTE_CONFIG_DISABLED).toBe('0');
    expect(a.CODEBUDDY_CREDENTIALS_IN_MEMORY).toBe('1');
    expect(environment.CODEBUDDY_DISABLE_PRODUCT_CACHE).toBe('0');
    expect(environment).not.toHaveProperty('ACC_PRODUCT_CONFIG_V3');
    expect(a).not.toBe(b);a.TEST_LOCAL_ONLY='test';expect(b.TEST_LOCAL_ONLY).toBeUndefined();
    expect(await readFile(join(china.cli,'product.json'),'utf8')).toBe(chinaProduct);
    expect(await readFile(join(international.cli,'product.json'),'utf8')).toBe(internationalProduct);
  });
  it.each(['ACC_PRODUCT_CONFIG_V3','ACC_PRODUCT_CONFIG_V2','ACC_PRODUCT_CONFIG'])('rejects competing %s without exposing its value',async(name)=>{
    const installation=await fixture('china');
    const secretValue='private-configuration-that-must-not-be-logged';
    await expect(bindWorkbuddyProduct(installation.executable,{[name]:secretValue})).rejects.toThrow(name);
    try{await bindWorkbuddyProduct(installation.executable,{[name]:secretValue});throw Error('Expected conflict');}
    catch(error){expect(String(error)).not.toContain(secretValue);}
  });
  it('rejects a different configured product path and accepts the selected file',async()=>{
    const china=await fixture('china'),international=await fixture('international');
    const configured=join(international.cli,'product.json');
    try{await bindWorkbuddyProduct(china.executable,{ACC_PRODUCT_CONFIG_PATH:configured});throw Error('Expected conflict');}
    catch(error){expect(String(error)).toContain('ACC_PRODUCT_CONFIG_PATH');expect(String(error)).not.toContain(configured);}
    const samePath=join(china.cli,'product.json');
    const env={ACC_PRODUCT_CONFIG_PATH:samePath};
    expect(await bindWorkbuddyProduct(china.executable,env)).toEqual({...env,ACC_PRODUCT_CONFIG_V3:await readFile(samePath,'utf8'),CODEBUDDY_DISABLE_PRODUCT_CACHE:'1'});
    expect(await bindWorkbuddyProduct(china.executable,env)).not.toBe(env);
  });
  it('allows exactly its own vendor V3 configuration on repeated binding',async()=>{
    const installation=await fixture('china');
    const first=await bindWorkbuddyProduct(installation.executable,{});
    const second=await bindWorkbuddyProduct(installation.executable,first);
    expect(second).toEqual(first);expect(second).not.toBe(first);
    const vendorProduct=await readFile(join(installation.cli,'product.json'),'utf8');
    expect(second.ACC_PRODUCT_CONFIG_V3).toBe(vendorProduct);
    await expect(bindWorkbuddyProduct(installation.executable,{ACC_PRODUCT_CONFIG_V3:vendorProduct+' '})).rejects.toThrow('ACC_PRODUCT_CONFIG_V3');
  });
  it('leaves unknown wrappers unbound and preserves their own environment',async()=>{
    const installation=await fixture('china');
    await writeFile(join(installation.cli,'product.json'),'{}');
    const env={ACC_PRODUCT_CONFIG_PATH:'wrapper-managed-path',ACC_PRODUCT_CONFIG_V3:'wrapper-managed-overlay'};
    const output=await bindWorkbuddyProduct(installation.executable,env);
    expect(output).toEqual(env);expect(output).not.toBe(env);
    const missingEnvironment={CODEBUDDY_DISABLE_PRODUCT_CACHE:'0',CODEBUDDY_REMOTE_CONFIG_DISABLED:'0'};
    const missing=await bindWorkbuddyProduct(join(installation.directory,'missing'),missingEnvironment);
    expect(missing).toEqual(missingEnvironment);expect(missing).not.toBe(missingEnvironment);
    expect(missing).not.toHaveProperty('ACC_PRODUCT_CONFIG_V3');
  });
});

describe('WorkBuddy distribution and lite compatibility', () => {
  it('identifies both distributions from vendor product identity despite misleading directory names', async () => {
    const china = await fixture('china', 'WorkBuddyAI'), international = await fixture('international', 'WorkBuddy');
    const rows = await discoverWorkbuddyInstallations({ candidates: [china.executable, international.executable, china.executable, join(china.root, 'missing')] });
    expect(rows).toEqual([
      { edition: 'china', executable: china.executable, desktopPath: china.desktopPath, desktopVersion: '5.8.4', productId: china.productId, cliVersion: '2.161.0', executionPackage: 'lite' },
      { edition: 'international', executable: international.executable, desktopPath: international.desktopPath, desktopVersion: '5.8.4', productId: international.productId, cliVersion: '2.161.0', executionPackage: 'lite' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('do-not-expose-product');
    expect(JSON.stringify(rows)).not.toContain('do-not-expose-package');
  });
  it('reports the public full entry only when the preferred lite artifact is absent', async () => {
    const installation=await fixture('china');
    await writeFile(join(installation.cli,'dist/codebuddy.js'),'// Synthetic full artifact; never executed.');
    expect((await discoverWorkbuddyInstallations({candidates:[installation.executable]}))[0]).toMatchObject({executionPackage:'lite'});
    await rm(join(installation.cli,'dist/codebuddy-lite-wb.mjs'));
    expect((await discoverWorkbuddyInstallations({candidates:[installation.executable]}))[0]).toMatchObject({executionPackage:'full'});
  });
  it('keeps absent or malformed public metadata unknown instead of guessing from names', async () => {
    const installation=await fixture('international');
    await writeFile(join(installation.cli,'package.json'),JSON.stringify({version:'9.9.9',publishConfig:{customPackage:{version:'untrusted private text'}}}));
    await rm(join(installation.cli,'dist'),{recursive:true});
    const first=(await discoverWorkbuddyInstallations({candidates:[installation.executable]}))[0];
    expect(first).toMatchObject({edition:'international',desktopVersion:'5.8.4'});
    expect(first).not.toHaveProperty('cliVersion');expect(first).not.toHaveProperty('executionPackage');
    await rm(join(installation.cli,'package.json'));
    const second=(await discoverWorkbuddyInstallations({candidates:[installation.executable]}))[0];
    expect(second).toEqual(first);
  });
  it('does not label a standalone or malformed executable from its directory name', async () => {
    const installation = await fixture('china', 'WorkBuddy');
    await writeFile(join(installation.cli, 'product.json'), '{broken');
    expect(await discoverWorkbuddyInstallations({ candidates: [installation.executable] })).toEqual([]);
    await expect(resolveWorkbuddyExecutable(installation.executable, 'china')).rejects.toThrow('不匹配');
    // Legacy explicit executable configurations remain usable without inventing an edition.
    expect(await resolveWorkbuddyExecutable(installation.executable)).toBe(installation.executable);
  });
  it('honors explicit edition paths and rejects a conflicting generic override without switching distribution', async () => {
    const china = await fixture('china'), international = await fixture('international');
    vi.stubEnv('AWB_WORKBUDDY_PATH', '');
    vi.stubEnv('AWB_WORKBUDDY_CHINA_PATH', china.executable);
    vi.stubEnv('AWB_WORKBUDDY_INTERNATIONAL_PATH', international.executable);
    expect(await resolveWorkbuddyExecutable(undefined, 'china')).toBe(china.executable);
    expect(await resolveWorkbuddyExecutable(undefined, 'international')).toBe(international.executable);
    vi.stubEnv('AWB_WORKBUDDY_PATH', china.executable);
    await expect(resolveWorkbuddyExecutable(undefined, 'international')).rejects.toThrow('不匹配');
    expect(await resolveWorkbuddyExecutable()).toBe(china.executable);
    // A profile's explicit path wins over the process-wide default.
    expect(await resolveWorkbuddyExecutable(international.executable, 'international')).toBe(international.executable);
  });
  it('keeps distribution separate from API region and validates the shared input', () => {
    expect(normalizeConnection({ name: 'Intl native', runtime: 'workbuddy', mode: 'native', workbuddyEdition: 'international' })).toMatchObject({workbuddyEdition:'international',region:'china'});
    expect(normalizeConnection({ name: 'Legacy', runtime: 'workbuddy', mode: 'native' })).not.toHaveProperty('workbuddyEdition');
    expect(() => normalizeConnection({ name: 'Invalid', runtime: 'codex', mode: 'native', workbuddyEdition: 'china' })).toThrow('仅适用于 WorkBuddy');
    expect(() => normalizeConnection({ name: 'Invalid', runtime: 'workbuddy', mode: 'native', workbuddyEdition: 'invalid' as WorkbuddyEdition })).toThrow('有效的发行版');
  });
  it('keeps concurrent native launch paths and environment isolated without changing authentication routing', async () => {
    const china = await fixture('china'), international = await fixture('international');
    vi.stubEnv('CODEBUDDY_FORCE_LITE_WB_BUNDLE', '0');
    vi.stubEnv('CODEBUDDY_AUTH_TOKEN', 'synthetic-inherited-token');
    const [a,b] = await Promise.all([
      profileOverrides(china.directory, profile(china.executable, 'china'), undefined, china.directory),
      profileOverrides(international.directory, profile(international.executable, 'international'), undefined, international.directory),
    ]);
    expect(a.executable).toBe(china.executable); expect(b.executable).toBe(international.executable);
    expect(a.workbuddyEdition).toBe('china'); expect(b.workbuddyEdition).toBe('international');
    for (const config of [a,b]) {
      expect(config.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBe('1');
      expect(config.env.CODEBUDDY_AUTH_TOKEN).toBe('synthetic-inherited-token');
      expect(config.env.CODEBUDDY_CONFIG_DIR).toBe(process.env.CODEBUDDY_CONFIG_DIR);
    }
    expect(process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBe('0');
    expect(process.env.CODEBUDDY_AUTH_TOKEN).toBe('synthetic-inherited-token');
    await expect(profileOverrides(china.directory, profile(china.executable, 'international'), undefined, china.directory)).rejects.toThrow('不匹配');
  });
  it('adds lite selection to API child configuration while dropping competing native credentials', async () => {
    const installation = await fixture('international');
    vi.stubEnv('CODEBUDDY_AUTH_TOKEN', 'native-must-not-cross');
    const config = await profileOverrides(installation.directory, profile(installation.executable, 'international', 'official-api'), 'api-synthetic', installation.directory);
    expect(config.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBe('1');
    expect(config.env.CODEBUDDY_API_KEY).toBe('api-synthetic');
    expect(config.env.CODEBUDDY_AUTH_TOKEN).toBeUndefined();
    expect(process.env.CODEBUDDY_AUTH_TOKEN).toBe('native-must-not-cross');
  });
  it('invalidates native verification context after a vendor distribution update', async () => {
    const installation = await fixture('international');
    const connection = profile(installation.executable, 'international');
    const before = await connectionContextFingerprint(connection, installation.directory);
    await writeFile(join(installation.root, 'resources/install-manifest.json'), JSON.stringify({appVersion:'5.8.5'}));
    expect(await connectionContextFingerprint(connection, installation.directory)).not.toBe(before);
  });
  it('invalidates verification for public CLI metadata or vendor product changes without exposing their contents', async () => {
    const installation=await fixture('china'), connection=profile(installation.executable,'china');
    const initial=await connectionContextFingerprint(connection,installation.directory);
    await writeFile(join(installation.cli,'package.json'),JSON.stringify({publishConfig:{customPackage:{version:'2.162.0'}}}));
    const upgraded=await connectionContextFingerprint(connection,installation.directory);
    expect(upgraded).not.toBe(initial);
    await rm(join(installation.cli,'dist/codebuddy-lite-wb.mjs'));
    await writeFile(join(installation.cli,'dist/codebuddy.js'),'// Synthetic full artifact; never executed.');
    const full=await connectionContextFingerprint(connection,installation.directory);
    expect(full).not.toBe(upgraded);
    await writeFile(join(installation.cli,'product.json'),JSON.stringify({authentication:{id:installation.productId},publicVendorRevision:'public-config-revision'}));
    const changedProduct=await connectionContextFingerprint(connection,installation.directory);
    expect(changedProduct).not.toBe(full);
    for(const value of [initial,upgraded,full,changedProduct])expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(changedProduct).not.toContain('public-config-revision');
  });
  it('binds a legacy default to the actual executable even when no product identity is available', async () => {
    const installation = await fixture('china'), other = await fixture('china');
    await writeFile(join(installation.cli,'product.json'),'{}');
    await writeFile(join(other.cli,'product.json'),'{}');
    const connection = { ...profile(installation.executable), executable: undefined };
    vi.stubEnv('AWB_WORKBUDDY_PATH',installation.executable);
    const before = await connectionContextFingerprint(connection, installation.directory);
    vi.stubEnv('AWB_WORKBUDDY_PATH',other.executable);
    expect(await connectionContextFingerprint(connection, installation.directory)).not.toBe(before);
  });
  it('uses lite for version checks, runtime initialization and model metadata without a user prompt', async () => {
    for (const edition of ['china','international'] as const) {
      const installation = await fixture(edition);
      const config = await profileOverrides(installation.directory, profile(installation.executable, edition), undefined, installation.directory);
      expect(await discoverRuntime('workbuddy', installation.executable)).toMatchObject({available:true,version:'2.161.0-synthetic'});
      const catalog = await discoverRuntimeModels('workbuddy', installation.directory, config);
      expect(catalog.models).toEqual([{id:`${edition}-model`,name:edition,isDefault:true}]);
      expect(JSON.stringify(catalog)).not.toContain('private-');
      const events: RuntimeEvent[] = [];
      const connection = await workbuddyAdapter.connect({agentId:'synthetic',cwd:installation.directory,instructions:'',permissionMode:'read-only',connection:config}, event => events.push(event));
      try { expect(events).toContainEqual(expect.objectContaining({type:'ready',data:{model:`${edition}-model`}})); }
      finally { await connection.close(); }
      expect(JSON.stringify(events)).not.toContain('private-');
    }
  });
  it('does not mutate caller environment or leak MCP credentials in launch arguments', () => {
    const env = { CODEBUDDY_FORCE_LITE_WB_BUNDLE:'0', CODEBUDDY_AUTH_TOKEN:'native-secret' };
    expect(workbuddyEnvironment(env)).toEqual({...env,CODEBUDDY_FORCE_LITE_WB_BUNDLE:'1'});
    expect(env.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBe('0');
    const launch = workbuddyLaunch('synthetic', {agentId:'test',cwd:'.',instructions:'',permissionMode:'read-only',connection:{connectionId:'test',revision:1,env},mcpServers:{probe:{command:'node',args:[],env:{KEY:'mcp-secret'}}}});
    expect(launch.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBe('1');
    expect(launch.env.CODEBUDDY_AUTH_TOKEN).toBe('native-secret');
    expect(launch.args.join(' ')).not.toContain('mcp-secret');
  });
});
