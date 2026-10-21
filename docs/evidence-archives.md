# 验收证据归档

将已选定的验收报告、截图、输入快照、成果文件或 Git bundle 保存到长期保留的目录，避免唯一副本留在系统临时目录。工具只复制显式清单中的普通文件，不解析报告里的路径、不运行 Agent、不修改证据内容或原数据库。

## 创建与核验

在仓库根目录执行：

```powershell
node --import tsx scripts/archive-upgrade-evidence.ts create --source=C:/Verification/example --target=D:/Evidence/example --list=D:/Evidence/example-files.json
node --import tsx scripts/archive-upgrade-evidence.ts verify --archive=D:/Evidence/example
```

目标必须是不存在的新目录，不能与源目录相同或互相包含。清单路径相对于源目录；拒绝目录穿越、链接文件、链接目录和重复文件。也可用多个 `--file=report.json` 参数代替清单。

清单格式：

```json
{
  "references": {
    "workflowId": "原工作流 ID",
    "scopeNote": "原生执行证据；缺失回执仍为未知"
  },
  "files": [
    "report.json",
    {
      "path": "outputs/report.html",
      "expectedSha256": "替换为原成果包中的64位小写SHA256",
      "references": {
        "bundleId": "原成果包 ID",
        "version": "原成果版本"
      }
    }
  ]
}
```

`expectedSha256` 可省略；已有固定版本成果时应填写原记录中的哈希。工具会先核对该版本，再检查复制前、复制过程、复制后源文件和目标文件的 SHA256 与大小一致。

归档包含：

- `files/`：所选文件的原始内容。
- `manifest.json`：来源、引用、相对路径、大小和哈希。
- `archive-state.json`：归档是否完整完成；失败保留 `incomplete`，不会伪装成成功。

核验不依赖源文件仍然存在，检查完整状态、清单格式、文件哈希、缺失文件和清单外的额外文件；不通过时命令返回非零退出码。归档失败后保留原目录供核对，重试请使用另一个新目标。

## 范围

这是**验收证据归档**，不是完整备份或一键恢复包，清单中明确保存 `restoreReady: false`。它不自动包含 SQLite、Beads 数据、所有工作树、原生会话、外部技能或未选文件。Git bundle 只保存导出的提交对象与引用，不包含未提交工作区或任务数据库。

工具不自动脱敏。只选择本次验收所需且适合保留的材料；已有报告中的未知终态、失败和限制原样保留，复制成功不代表业务验收成功。应用凭据目录不属于验收归档清单。
