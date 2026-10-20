# RouteManager

项目仓库：[PeacherMZ/RouteManager](https://github.com/PeacherMZ/RouteManager)。

Tauri 2 + Rust + React/Fluent UI + SQLite 桌面路由管理器。目标平台为 Windows 10/11 x64、macOS 13+ Apple Silicon；支持 IPv4 管理、IPv6 只读、配置与分组、操作预览、执行核验及 hosts 编辑。

## 安装与升级

在 [GitHub Releases](https://github.com/PeacherMZ/RouteManager/releases) 中下载对应安装包，发布标题为 `RouteManager X.Y.Z`：

- Windows：推荐 `RouteManager_<版本>_windows_x64-online-setup.exe` 轻量包，已装 WebView2 时直接复用，缺失时需联网下载。无网络且未装 WebView2 时使用 `RouteManager_<版本>_windows_x64-setup.exe` 完整离线包。两者默认安装到 `C:\Program Files\RouteManager`。已有安装的覆盖升级沿用原目录；若希望旧安装改用新目录，可先卸载应用（保留用户数据）再用新安装包安装。应用启动时请求 UAC，取消后不打开数据库或修改系统。
- macOS：`RouteManager_<版本>_macos_arm64.pkg`，安装到 `/Applications/路由管理器.app`。查看和保存配置无需管理员权限；系统修改时弹出授权对话框，临时助手执行结束后退出。

升级前退出程序，直接运行新版本安装包。安装器拒绝覆盖正在运行的应用和降级安装；升级、卸载均保留用户数据。不要同时运行不同版本访问同一数据目录。

当前 Windows 包未签名；macOS 应用及助手使用 ad-hoc 签名，PKG 未签名、未公证，首次安装或打开可能需要系统安全设置放行。这不是 Developer ID 签名。正式签名接入见 [发布说明](docs/release.md)。

## 用户数据

| 平台 | 默认位置 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\com.local.route-manager` |
| macOS | `~/Library/Application Support/com.local.route-manager` |

路径由系统 API 获取，不硬编码用户名。Windows 在提权前保留启动者身份；通过另一管理员账户完成 UAC 时仍使用启动者目录。从已提权终端直接运行则使用该终端用户身份。

- `routes.db`：配置、分组、设置、历史与创建证据。
- `backups/`：数据库结构升级、导入和 hosts 保存前的备份。
- `exports/`：YAML 导出；新版为 v3，兼容 v1/v2 导入。
- `instance.lock`：由操作系统持有的数据库目录锁，崩溃后自动释放。

设置页显示实际目录。备份整个目录前先退出程序。数据库升级先备份再事务迁移；旧程序拒绝打开较新的结构，不会重置为空库。

**不自动发现或迁移旧便携版 `data/`、`legacy/`。** 新安装首次启动为空配置，可手动导入已有 YAML。导入替换配置与分组，并先备份；不会应用系统路由。跨平台接口不能自动对应，应重新选择网卡；macOS 应用配置前需清除 Windows metric。

开发构建使用 `com.local.route-manager.dev` 子目录。`--data-dir <绝对路径>` 可显式指定独立目录，用于测试或诊断。

## 配置库与分组

- 每条配置右侧的“复制”会打开独立副本，保留参数和原分组；修改目标网段、网关或接口后保存，完全重复的路由会被拦截。
- 勾选配置后点击“批量修改”，按需统一修改目标网段、网关、接口、metric、持久属性或备注；macOS 可修改临时路由作用域。只更新勾选字段，metric 和备注支持清空，分组与未选配置保持原样。筛选外的已选项会显示数量，弹窗可查看全部所选配置。
- 网关输入支持手动填写和系统已有 IPv4 网关选择；候选去重并显示接口，`0.0.0.0` 标为直连。点击“刷新网关列表”重新读取系统快照；选择地址不会自动更改接口。
- 复制和批量修改只保存配置，应用时仍需系统变更预览与执行核验。

## 平台行为

- 当前路由以系统读取结果为准；保存配置或分组不会隐式修改路由。
- 系统修改先预览、执行前重读、串行执行、完成后核验；部分失败与恢复失败分别报告。
- “受管理”仅表示配置命中，不证明创建来源。清除受管理路由保留配置及其他路由。
- Windows 使用 NetTCPIP，并分别核验活动和持久记录；旧无接口持久记录仅在活动接口唯一时关联。
- macOS 使用原生路由表与 SystemConfiguration 的网络服务 AdditionalRoutes。系统负责持久路由恢复，应用不创建开机任务、登录启动项或常驻服务。
- macOS 没有 Windows metric 的对应编辑能力；没有唯一网络服务的接口只支持临时路由。作用域或服务存在歧义时拒绝猜测；含特殊属性的持久记录拒绝破坏性修改。
- hosts 保存前备份和检查外部修改，保留编码、换行及平台文件元数据。

## 开发与验证

使用 Node.js 24、package.json 指定的 pnpm、Rust 1.99.0（与 CI 一致）。Windows 需要 MSVC、Windows SDK、PowerShell 7；macOS 需要 Xcode Command Line Tools，且打包必须在 macOS 上执行。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
pnpm exec playwright install chromium webkit
pnpm exec playwright test
```

浏览器 `/?demo=1` 为明确标注的虚构演示数据。Windows：

```powershell
. ./scripts/Environment.ps1
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/windows-adapter.ps1
pwsh -File scripts/Build.ps1
```

macOS：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked
node scripts/build.mjs
pnpm desktop:dev
```

统一打包入口为 scripts/build.mjs。安装包及 SHA-256 文件位于 artifacts/release/；Windows 本地运行副本位于 artifacts/app/RouteManager.exe，构建时同步根目录快捷方式。开发工具链优先复用 .tools/，不随仓库分发。

仅编译应用可使用 Windows 的 `scripts/Build.ps1 -AppOnly`，或 `node scripts/build.mjs --app-only`；该模式不生成安装包。默认完整构建不会因网络失败而改为联网安装器。

测试使用独立临时数据库、模拟路由和临时 hosts。原生助手的 self-test 只运行合成契约，不修改系统网络。诊断示例必须显式提供独立数据目录，不隐式读取旧数据。

## 发布与验收

普通分支推送（包括合入 main）和 PR 不自动运行 CI；需要验证时，在 GitHub Actions 中选择工作流并点击 Run workflow 手动运行两平台测试和打包，安装包保存在 Actions artifacts。推送与应用版本一致的 vX.Y.Z 标签后，自动运行两平台测试和打包，全部成功才创建 Release **草稿**，上传 EXE、PKG 和校验文件。手动运行不创建 Release 草稿。人工完成实机、覆盖安装及重启验收后再公开发布。没有应用内自动更新。

查看 [架构](docs/architecture.md)、[发布配置](docs/release.md)、[验收清单](docs/acceptance.md)、[本次验证范围](docs/verification.md)。模拟测试、浏览器 WebKit 测试和编译成功均不等价于 macOS 实机验收。

## 公开仓库

仅提交源码、锁文件、应用图标及虚构测试数据。data/、legacy/、artifacts/、.tools/、安装包、截图、日志和诊断资料保持忽略；禁止提交真实路由、hosts、内部地址、设备标识、凭据或个人路径。提交和推送前检查完整暂存清单与差异，不使用强制添加绕过忽略规则。
