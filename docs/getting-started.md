# 启动与配置

本项目面向单用户的本机 Windows 环境。网页与后台共同构成工作台；不要将本地服务直接暴露到公网。

## 1. 准备环境

- Node.js 24，包含 npm；后端使用内置 `node:sqlite`。
- Git，能够在新终端执行 `git --version`。
- Beads CLI，能够执行 `bd --version`。任务管理及办公项目控制仓依赖 Beads；没有安装时仍可查看界面与配置连接，不能完成任务协作。
- 需要使用的 Codex、Claude Code 或 WorkBuddy 原生工具。工作台不附带工具账号或服务额度。

代码项目须是已有提交的 Git 仓库，选择仓库根目录。普通办公文件夹通过办公项目接入，任务控制数据放在工作台管理的控制仓中。

## 2. 启动服务

在仓库根目录运行：

```powershell
npm ci
npm run build
npm start
```

打开 [http://127.0.0.1:4310](http://127.0.0.1:4310)，保持服务终端运行。使用 `Ctrl + C` 结束此前先在界面中断仍在执行的成员，并等待停止确认。

Windows 也提供启动入口：

```powershell
.\Start-Workbench.cmd
.\Start-Workbench.cmd -Port 4312 -NoBrowser
```

启动脚本会在依赖不存在时执行安装，随后构建。相同端口已有工作台时复用该服务；端口被其他应用占用时提示冲突。`-SkipBuild` 仅适用于已经构建且源码没有变化的情况。

使用启动脚本启动的服务，可通过下列脚本核对进程身份后关闭：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Stop-Workbench.ps1
```

后台进程能否在启动终端退出后继续运行取决于启动宿主。运行回执文件不是存活证明，可通过页面或 `/api/health` 核对当前服务。

## 3. 数据与可选配置

默认数据目录为当前用户主目录下的 `.agent-workbench`，包含数据库、附件和工作区。启动脚本的日志与进程回执另存于本项目 `.workbench`。这些都是个人运行数据，不应提交到 Git。

| 环境变量 | 用途 |
| --- | --- |
| `WORKBENCH_DATA_DIR` | 自定义数据目录 |
| `WORKBENCH_PORT` | 直接执行 `npm start` 时使用的端口；启动脚本使用 `-Port` |
| `WORKBENCH_BD_PATH` | Beads `bd` 可执行文件完整路径 |
| `WORKBENCH_PROJECT_ROOTS` | 额外的项目发现目录，Windows 用分号分隔 |
| `AWB_CODEX_PATH` | Codex 原生运行程序完整路径 |
| `AWB_CLAUDE_PATH` | Claude Code 原生运行程序完整路径 |
| `AWB_WORKBUDDY_PATH` | WorkBuddy 安装目录内的 `resources\app.asar.unpacked\cli\bin\codebuddy` 脚本路径，不能填写桌面 EXE |
| `WORKBENCH_OFFICE_CONVERTER` | 可选 LibreOffice `soffice.exe`，用于 DOCX/PPTX 的 PDF 视觉预览 |

例如为独立试用实例使用项目内的数据目录与其他端口：

```powershell
$env:WORKBENCH_DATA_DIR = Join-Path $PWD '.workbench\trial-data'
$env:WORKBENCH_PORT = '4312'
npm start
```

使用启动脚本时也可明确指定：

```powershell
.\Start-Workbench.cmd -Port 4312 -DataDir .workbench\trial-data -NoBrowser
```

同一数据目录只能由一个服务实例使用。启动前更改环境变量；不要将真实 API Key 写入仓库中的脚本、示例或配置文件。

## 4. 配置工具与登录

进入「接入中心」，按工具完成安装检测、连接配置和认证检查。可以沿用本机原生认证，也可新增该工具支持的官方 API 或兼容网关。配置仅通过后台应用到受控进程，不要求每位成员注册新账号。

原生登录需要在工具的官方浏览器或终端界面完成。API Key 只在接入中心输入；不要粘贴到成员聊天。原生凭据由原生工具管理，工作台新增 API Key 在 Windows 使用 DPAPI 保存。

普通刷新不会发起模型推理。明确点击调用验证会产生少量真实用量，并检查对应连接的能力；更换连接或配置版本后须重新核对。模型目录只说明可以选择的标识，不证明账号有额度或服务可以调用。

### WorkBuddy 国内版与国际版

适配目标为 WorkBuddy 安装包内置的 CodeBuddy CLI，独立 CodeBuddy CLI 与 WorkBuddy 桌面额度不能混为一谈。

- 两个版本分别识别安装、产品配置与认证入口；国内扫码与国际网页登录按实际原生页面完成。
- 桌面已登录不代表后台启动的内置 CLI 已登录。部分版本使用进程内授权，每个新进程都可能重新请求认证。
- 原生授权链接只对当前请求有效。按页面及时完成，超时后从工作台重新发起，不重复扫描旧页面。
- 认证状态与真实调用结果分开显示；不能仅凭找到桌面程序或授权页成功打开判断接入完成。
- 无法自动识别安装目录时，在启动服务前设置 `AWB_WORKBUDDY_PATH`，或在接入中心选择实际安装版本。

不要为排查登录问题复制订阅令牌、读取受保护凭据或将完整原生诊断日志上传到公开问题区。

## 5. 第一个协作计划

1. 先接入一个独立示例仓库或办公文件夹，避免直接以重要项目验收新配置。
2. 创建主控、实施和独立审查成员，分别选择执行工具、连接与模型。
3. 验证所需连接与能力，向主控说明目标、输入、允许范围和验收要求。
4. 在「编排」核对任务、负责人、依赖及检查命令，再确认计划。
5. 在会话与任务详情观察实际执行。已有执行时，发送新内容会先中断并等待停止，再纠正；人工接管会阻止主控继续自动派发该成员。
6. 在「成果」核对候选版本、测试与独立审查。返工产生新轮次；任务验收、本地整合和对外交付分别处理。

连接断开或服务重启后，未确认的执行应先核对。不要通过重复点击、重新建任务或换成员来绕过未知状态。

## 6. 验证与问题反馈

```powershell
npm run typecheck
npm run build
npm test -- --maxWorkers=2
```

CI 在 Windows 与 Node.js 24 上执行这些检查，不配置模型账号。缺失 Beads 时相关真实 CLI 用例会跳过；原生 Agent、真实图片与工具能力仍需单独验收。

提交问题前去掉 API Key、授权链接、邮箱、个人目录、业务附件和内部地址。描述使用的工具版本、操作步骤、经过脱敏的错误信息，以及是否已确认原进程停止；不要上传工作台数据库或整份日志目录。
