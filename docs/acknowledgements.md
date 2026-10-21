# 开源项目与第三方致谢

感谢以下项目的维护者与贡献者。设计参考根据前期调研记录与上游项目资料核对；直接依赖清单根据本次发布的 `package.json`、`package-lock.json` 以及相同版本的软件包元数据核对，版本是锁文件的解析版本，不是依赖声明中的版本范围。

## 前期调研与设计参考

| 项目 | 作者／来源 | 调研与参考方向 | 当前发布版本的关系 |
| --- | --- | --- | --- |
| [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek AI 及贡献者；上游采用 MIT | Agent Harness、插件化能力组织、会话及开发协作架构；曾进行独立路线调研与试验 | 设计参考，未作为工作台运行依赖；独立试验不计入当前工作台的功能验收 |
| [HubMemory／hubmemory-skill](https://github.com/llMinecraft/hubmemory-skill) | **llMinecraft** 及贡献者；[Gitee 镜像](https://gitee.com/llMinecraft/hubmemory-skill) | 本机跨 Agent 会话归档、共享上下文与记忆、历史检索和来源追溯 | 设计参考；工作台尚未集成其共享记忆能力，当前会话、事件与 Token 记录由工作台自己的实现管理 |

特别感谢 llMinecraft 公开分享 HubMemory 的设计与实现。[维护者的 HubMemory Fork](https://github.com/Reyourn/hubmemory-skill) 是独立仓库，不能替代原作者署名，也不代表已整合至本工作台。

HubMemory 上游当前未附带开源许可证，公开可读不等于获得任意使用或分发授权；本项目 MIT 不覆盖其源码。这里列明参考来源，不重新许可上游代码，也不将设计调研描述为已接入功能。后续如引入上游代码或运行程序，须另行核对适用许可与来源声明。

## 实际使用的开源依赖

| 项目／npm 包 | 锁定版本 | 许可证／条款 | 实际用途 |
| --- | --- | --- | --- |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre) | 3.1.1 | MIT | 任务依赖图自动排列 |
| [@fastify/static](https://github.com/fastify/fastify-static) | 10.1.5 | MIT | 本机静态前端与文件服务 |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.32.1 | MIT | 本地 stdio MCP 桥、能力发现与调用 |
| [@xyflow/react](https://github.com/xyflow/xyflow) | 12.12.0 | MIT | 任务编排画布、节点连线与视图操作 |
| [exceljs](https://github.com/exceljs/exceljs) | 4.4.0 | MIT | XLSX 单元格与缓存公式结果提取 |
| [fastify](https://github.com/fastify/fastify) | 5.12.5 | MIT | 本地 HTTP、SSE 和接口生命周期 |
| [lucide-react](https://github.com/lucide-icons/lucide) | 0.468.0 | ISC | 界面图标 |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 1.13.0 | BSD-2-Clause | DOCX 文字提取 |
| [mermaid](https://github.com/mermaid-js/mermaid) | 12.2.0 | MIT | 成果中的 Mermaid 图预览 |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | 6.4.299 | Apache-2.0 | PDF 文字提取和页面预览 |
| [react](https://github.com/react/react) | 19.3.0 | MIT | 前端组件和状态 |
| [react-dom](https://github.com/react/react) | 19.3.0 | MIT | 浏览器组件渲染 |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 10.1.0 | MIT | Markdown 成果与消息渲染 |
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | 4.0.1 | MIT | GitHub Flavored Markdown 支持 |
| [saxes](https://github.com/lddubeau/saxes) | 5.0.1 | ISC | PPTX OOXML 的命名空间感知 XML 解析 |
| [zod](https://github.com/colinhacks/zod) | 4.6.5 | MIT | 接口与 MCP 参数校验 |

## 构建、类型与验证工具

| 项目／npm 包 | 锁定版本 | 许可证／条款 | 实际用途 |
| --- | --- | --- | --- |
| [@playwright/test](https://github.com/microsoft/playwright) | 1.64.0 | Apache-2.0 | 实际浏览器验收脚本 |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.19.1 | MIT | Node.js TypeScript 类型声明 |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT | React TypeScript 类型声明 |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT | React DOM TypeScript 类型声明 |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | 4.7.0 | MIT | Vite 的 React 编译集成 |
| [tsx](https://github.com/privatenumber/tsx) | 4.23.15 | MIT | 开发期 TypeScript 执行与验证脚本 |
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 | 类型检查与服务端编译 |
| [vite](https://github.com/vitejs/vite) | 6.4.4 | MIT | 前端开发服务和生产构建 |
| [vitest](https://github.com/vitest-dev/vitest) | 5.0.3 | MIT | 单元及集成测试 |

开发依赖不等于每次运行都会加载的产品能力。传递依赖由锁文件记录，以上表格只列直接依赖；其版权和许可证继续归各上游所有。

## 单列的厂商 SDK

| 项目／npm 包 | 锁定版本 | 许可证／条款 | 实际用途 |
| --- | --- | --- | --- |
| [@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript) | 0.3.295 | SEE LICENSE IN README.md | Claude Code 持久流式会话、消息和工具审批适配 |

该版本的 Claude Agent SDK 不按 MIT 等开放源代码许可证列入上表。软件包的声明指向其 README；随包 LICENSE.md 保留 Anthropic 的权利声明，并指向[厂商法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance)。本项目的 MIT 许可证不覆盖该 SDK、Claude Code 或模型服务。

## 外部运行程序与基础设施

| 项目 | 本工作台如何使用 | 分发边界 |
| --- | --- | --- |
| [Node.js](https://github.com/nodejs/node) | JavaScript 后端及内置 `node:sqlite` | 由使用者安装，不随本仓库分发运行程序 |
| [SQLite](https://sqlite.org/) | 通过 Node 内置接口保存配置、回执与事件 | 由 Node 提供，不含本地数据库 |
| [Git](https://github.com/git/git) | 提交、独立工作树和整合分支 | 调用本机 Git，不包含其程序或业务仓库 |
| [Beads](https://github.com/gastownhall/beads) | 调用 `bd` 管理任务生命周期及依赖 | 调用本机 CLI，不包含私人任务库；上游原 steveyegge/beads 地址重定向至此 |
| [OpenAI Codex](https://github.com/openai/codex) | App Server 线程、轮次、中断和模型目录 | 调用本机安装；Codex 项目源码为 Apache-2.0，模型服务另有服务条款 |
| [Claude Code](https://code.claude.com/docs/en/overview) | Agent SDK 连接本机原生执行程序 | 厂商产品；原生程序、账号与服务不由本项目重新许可 |
| [WorkBuddy 国内版](https://www.workbuddy.cn/)／[国际版](https://www.workbuddy.ai/) | 调用各自安装包内的 CodeBuddy CLI 执行层 | 厂商产品；不复制、修改或分发其 CLI、产品配置与认证资料 |
| [LibreOffice](https://www.libreoffice.org/) | 安装后可用于 DOCX／PPTX 的 PDF 视觉转换 | 可选本机转换器，不随仓库分发 |

## 协议与文档参考

以下链接是适配接口、认证和布局的参考资料，不表示复制了网站界面、示例仓库或第三方产品源码：

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：线程、执行控制与原生认证接口。
- [Claude Agent SDK 流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)和[认证说明](https://code.claude.com/docs/en/authentication)：持久输入、原生执行与认证边界。
- [CodeBuddy Agent SDK](https://www.codebuddy.ai/docs/cli/sdk)和[CLI 认证说明](https://www.codebuddy.cn/docs/cli/iam)：官方接入与认证资料；当前 WorkBuddy 适配使用其内置 CLI，不依赖另一个 CodeBuddy SDK npm 包。
- [React Flow 布局说明](https://reactflow.dev/learn/layouting/layouting)：画布布局与自动排列。
- [Model Context Protocol](https://modelcontextprotocol.io/)：本机 MCP 的协议与 SDK。

会话为主体、两侧面板可折叠、输入框底部选择模型等交互参考了 Codex 的使用体验；这属于交互参考，不宣称使用或取得 Codex 桌面界面的源代码。

## 图片与角色

随仓库保留的 02 静态壁纸是生成的同人角色插画，生成方式与提示记录在 [背景来源记录](zero-two-background.json)。Zero Two／02 和《DARLING in the FRANXX》的角色、名称及相关权利归各自权利人；它们不因本项目源代码采用 MIT 而被授予角色或商标许可。图片不是从参考视频、第三方案例页面或用户截图中截取的。

许可证原文与已随包提供的版权／NOTICE 见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。本项目与上述维护者、厂商及作品权利人无隶属、赞助或官方合作关系。
