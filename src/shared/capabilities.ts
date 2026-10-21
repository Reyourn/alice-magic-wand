import type { PermissionMode, RuntimeKind } from './types.js';

export interface RoleTemplate {
  id:string; name:string; memberKind:'controller'|'worker'; permissionMode:PermissionMode;
  instructions:string; inputs:string[]; acceptance:string[]; requiredCapabilities:string[];
}
export const ROLE_TEMPLATES:RoleTemplate[] = [
  {id:'controller',name:'主控／编排',memberKind:'controller',permissionMode:'read-only',instructions:'先了解目标、输入和成员能力，提出可验收的计划。等待用户确认整份计划，使用工作台工具协调依赖、独立审查及返工；不自行修改原项目或直接交付。',inputs:['目标','约束','项目规则'],acceptance:['完整计划','证据与交付说明'],requiredCapabilities:[]},
  {id:'fullstack',name:'全栈开发',memberKind:'worker',permissionMode:'workspace-write',instructions:'在分配工作区实现前后端需求，遵循接口契约，运行相关测试并提交候选版本。报告实际命令、退出码与剩余问题。',inputs:['需求','接口契约'],acceptance:['候选提交','开发测试'],requiredCapabilities:[]},
  {id:'reviewer',name:'独立审查',memberKind:'worker',permissionMode:'read-only',instructions:'对固定候选版本独立审查；给出问题位置、等级、影响和明确结论，不修改被审查成果。版本变化后重新审查。',inputs:['固定候选版本','验收要求'],acceptance:['版本明确的审查结论'],requiredCapabilities:[]},
  {id:'qa',name:'测试质量',memberKind:'worker',permissionMode:'workspace-write',instructions:'根据验收要求制定测试用例，执行自动化及实际使用路径，保存命令、日志、退出码和版本。区分模拟验证与真实工具验收。',inputs:['候选版本','验收要求'],acceptance:['测试用例','可复现测试证据'],requiredCapabilities:[]},
  {id:'product',name:'产品与交互',memberKind:'worker',permissionMode:'workspace-write',instructions:'将目标转为用户流程、交互说明和高保真原型。说明边界、空状态、错误状态和可用性验收。',inputs:['用户目标','使用场景'],acceptance:['需求与流程','可查看原型'],requiredCapabilities:[]},
  {id:'architecture',name:'架构与接口',memberKind:'worker',permissionMode:'workspace-write',instructions:'定义模块边界、接口契约、架构图及网络拓扑，说明输入输出、失败语义和兼容迁移。图表对应真实结构。',inputs:['系统约束','现有代码与接口'],acceptance:['接口契约','架构图与决策'],requiredCapabilities:[]},
  {id:'analyst',name:'数据分析',memberKind:'worker',permissionMode:'workspace-write',instructions:'只基于固定输入快照分析，先明确数据口径，再清洗、计算、可视化并保存可复现脚本。保留原文件，标记未知与异常。',inputs:['数据快照','分析口径'],acceptance:['分析结果','可复现脚本与关键数据核对'],requiredCapabilities:[]},
  {id:'documents',name:'文档与报告',memberKind:'worker',permissionMode:'workspace-write',instructions:'根据已核对的资料制作 Word、Excel、PPT 或 PDF，在输出目录保存原件和预览。检查文件可打开、公式、页数与视觉结果。',inputs:['固定资料','格式与模板'],acceptance:['可编辑原件','内容与视觉验证'],requiredCapabilities:[]},
  {id:'operations',name:'运维与交付',memberKind:'worker',permissionMode:'workspace-write',instructions:'准备环境、CI/CD、诊断脚本和可回滚交付方案。真实部署、推送、覆盖原文件须经工作台交付确认；准备工作与已部署分开报告。',inputs:['环境说明','候选版本'],acceptance:['部署准备','验证与回滚说明'],requiredCapabilities:[]},
  {id:'embedded',name:'硬件与嵌入式',memberKind:'worker',permissionMode:'workspace-write',instructions:'实现固件和协议，记录工具链、编译、模拟及设备验证条件。硬件缺失时明确标注未验证，不以仿真代替设备结果。',inputs:['硬件规格','协议','工具链'],acceptance:['固件或协议实现','编译与适用设备证据'],requiredCapabilities:[]},
  {id:'visual',name:'视觉设计',memberKind:'worker',permissionMode:'workspace-write',instructions:'根据视觉目标产出设计图与素材，使用已绑定且验证的工具。缺少图像生成工具时说明能力缺口，不能用文字声明已经生成图片。',inputs:['设计简报','参考与尺寸'],acceptance:['实际图像或设计文件','可查看成果'],requiredCapabilities:[]},
];
export interface CapabilityTool { name:string; description?:string; inputSchema?:Record<string,unknown>; }
export interface CapabilityValidation {runtime:RuntimeKind; revision:number; connectionId?:string; connectionRevision?:number; fingerprint?:string; stale?:boolean; observedModel?:string; observedProvider?:string; nativeSessionId?:string; state:'recognized'|'verified'|'failed'; checkedAt:string; tool?:string; messageId?:string; detail:string;}
export interface Capability {
  id:string; name:string; kind:'mcp'|'skill'|'script'|'native'; source:'managed'|'inherited'|'builtin'|'local'; revision:number;
  description:string; command?:string; args?:string[]; envRefs?:Record<string,string>; path?:string;
  status:'discovered'|'connected'|'failed'; tools:CapabilityTool[]; checkedAt?:string; detail?:string; validations:CapabilityValidation[];
}
export interface CapabilityInput {name:string;kind:'mcp'|'skill'|'script';description?:string;command?:string;args?:string[];envRefs?:Record<string,string>;path?:string;}
export interface CapabilityCandidate {id:string;name:string;kind:'mcp'|'skill';sourcePath:string;detail:string;}
export interface InboxItem {id:string;projectId?:string;agentId?:string;workflowId?:string;taskId?:string;kind:'plan'|'question'|'approval'|'authentication'|'recovery'|'delivery'|'rework'|'error';title:string;detail:string;state:'open'|'resolved';createdAt:string;resolvedAt?:string;answer?:string;}
export interface HistoryPage {events:import('./types.js').WorkbenchEvent[];nextBefore?:number;}
