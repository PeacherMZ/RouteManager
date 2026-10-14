# 路由管理器

Windows 10/11 x64 桌面应用，采用 Tauri 2、Rust、React、Fluent UI 和 SQLite。启动时请求管理员权限，管理 IPv4 路由并只读展示 IPv6。

用于查看实际路由、维护配置与分组、预览并执行变更，以及编辑本机 hosts。系统变更需要确认，并在执行后重新核验。公开仓库仅包含源码和虚构测试数据，不附带个人路由配置、数据库或已编译程序。

## 运行

构建完成后，双击根目录的 **路由管理器.lnk** 或 **启动路由管理器.cmd**。运行文件位于 `artifacts/app/RouteManager.exe`，数据保存在独立的 `data/` 目录。

移动整个项目后，使用 CMD 入口启动；运行 `scripts/Create-Shortcut.ps1` 可修复 LNK 的绝对路径。目标电脑需要 WebView2 Runtime。运行程序不需要 Node、Rust 或编译工具。

全新克隆默认使用空配置库。若首次启动前自行在 `legacy/routes.yaml` 放入兼容的旧版配置，程序会导入配置，**不会自动应用路由**。首次初始化后不会再次自动导入；后续可使用界面的 YAML 导入入口。`legacy/` 是本地私人目录，不随仓库分发。

## 使用

- **当前路由**：实际活动与持久路由的合并视图。可按目标、网关、接口、地址族、管理归属筛选，点击目标查看详情。
- **新增 / 修改 / 从系统移除**：先预览，确认后执行，完成后重新读取核验。IPv6 没有写入入口，后端也拒绝写入。
- **纳入管理**：将选中实际路由保存到配置库，不修改系统。
- **清除受管理路由**：只移除准确命中的活动与持久记录，保留配置及未命中路由。不是恢复出厂设置，也不等于恢复某个全机快照。
- **配置库与分组**：保存、编辑或删除配置不会自动修改路由；应用配置或分组才会修改系统。组内顺序可调整。
- **添加配置到分组**：在“全部配置”勾选一条或多条 → 点击“添加到分组” → 勾选目标分组（可多选）→“确认添加”。保留原分组，已有成员不重复添加，新成员追加到末尾。也可点击左侧目标分组 →“编辑分组”，勾选或取消成员并调整顺序 →“保存分组”。
- **操作记录**：显示逐项结果、执行前后状态及失败恢复结果。批量部分失败不会显示整体成功。
- **hosts**：保留原编码与换行，保存前备份并检查外部修改。
- **设置**：浅色、深色、跟随系统；前台自动刷新可选关闭或 5/10/30 秒。

“本管理器管理”表示配置库命中，不证明路由最初由本程序添加。“系统自动 / 动态”根据系统协议判定；其他静态路由显示“其他 / 来源未知”。历史创建记录独立显示。旧配置匹配多个网卡时必须先选择接口，不能直接批量清除。

旧版 route -p 的无接口持久记录会与唯一匹配的活动路由合并展示，删除仍精确定位原始记录。若多个接口共享同一无接口持久记录，会提示先检查持久记录，不能只绑定网卡就自动认领。

## 开发与构建

依赖：Windows x64、PowerShell 7（`pwsh`）、Node.js 24、`package.json` 指定版本的 pnpm 11、Rust MSVC 工具链、Microsoft C++ Build Tools、Windows SDK 和 WebView2 Runtime。系统自带的 Windows PowerShell 5.1 用于 NetTCPIP 适配和契约测试。构建脚本优先使用项目 `.tools/` 中的 Rust/MSVC 工具链，也支持全局安装；仓库不附带工具链或依赖。

```powershell
# 获取源码（克隆公开仓库无需 SSH 凭据）
git clone https://github.com/PeacherMZ/routing-table-manager.git
cd routing-table-manager

# 安装前端依赖
pnpm install --frozen-lockfile

# 只预览界面（无系统权限；/?demo=1 使用明确标注的模拟数据）
pnpm dev

# Tauri 开发
pwsh -File scripts/Dev.ps1

# 测试并生成 EXE、运行目录和根目录快捷方式
pwsh -File scripts/Build.ps1
```

模拟模式只在开发构建启用；发布程序不提供模拟写入，也不会联网加载网页代码。

```powershell
# 前端逻辑测试
pnpm test
# Edge 浏览器交互测试和页面截图，不修改系统路由
pnpm exec playwright test
# Rust 测试：所有路由写入使用内存模拟器，hosts 使用临时文件
. ./scripts/Environment.ps1
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked
# Windows PowerShell 5.1 模拟适配器契约测试
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/windows-adapter.ps1
```

测试不依赖本地 `legacy/` 或 `data/`；旧版迁移样例位于 `src-tauri/tests/fixtures/legacy-example.yaml`。演示与测试使用文档保留地址和合成 GUID，不能直接作为真实网络配置。

需要本机诊断时，加载 `scripts/Environment.ps1` 后运行 `cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --example inspect --locked -- <独立数据目录绝对路径>`。此工具只读系统路由，但会创建或迁移指定目录的数据库；省略目录会使用项目 `data/`。诊断输出可能包含本机信息，不能直接提交。

查看 [架构与接口](docs/architecture.md)、[验收说明](docs/acceptance.md) 和 [验证范围](docs/verification.md)。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/` | React/TypeScript 界面、类型、演示数据 |
| `src-tauri/` | Rust 后端、固定 PowerShell 脚本、数据库迁移与测试 |
| `tests/` | 前端、浏览器和 PowerShell 契约测试 |
| `scripts/` | 开发、构建、启动、清理工具 |
| `docs/` | 架构和验收说明 |
| `artifacts/`、`data/`、`legacy/`、`.tools/` | 仅本地使用，Git 忽略 |

## 公开提交约定

- 不提交真实路由、hosts、内部域名、网卡或设备标识、个人路径、凭据、数据库、备份、运行截图或诊断日志。
- `.gitignore` 排除私人目录、依赖、构建产物、本地代理状态与常见凭据文件；锁文件和应用图标属于源码资产，应保留。
- 提交前检查 `git status --short`、`git diff --cached --stat`、`git diff --cached` 和 `git ls-files`；忽略规则不会移除已跟踪内容，也不能识别写入源码的秘密。
- 新增示例使用虚构名称、文档保留地址（`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`、`2001:db8::/32`）及合成 GUID。不要强制加入被忽略的文件。
- 发布问题报告或截图前同样要脱敏。完整开发约束见 [AGENTS.md](AGENTS.md)。

## 数据与备份

- `data/routes.db`：配置、分组、设置、创建证据和操作记录。
- `data/backups/`：数据库升级／导入前备份，以及 hosts 保存前的备份。
- `data/exports/`：YAML 导出。新版含网卡 GUID、metric，导入兼容旧 destination/mask 格式。
- 导入会**替换**当前配置和分组；先完整校验并备份，再事务提交。不会修改实际路由。
- 备份整个 `data/` 前先退出程序。数据库较新时旧版程序拒绝降级打开。
- `scripts/Clean.ps1` 默认清除前端和 Rust 构建产物，保留运行目录；`-AllBuildArtifacts` 连运行目录一起清理。两种方式均不会清理 `data/` 或 `legacy/`。
- 本版管理本机默认网络隔离区，不覆盖容器等独立网络隔离区。

## 常见问题

**提示路由状态过期**：保留上次快照，但暂停界面的系统写入入口。检查管理员权限、Windows NetTCPIP/CIM 服务和网卡状态后刷新。

**接口待确认**：在配置库编辑对应路由，选择实际网卡。应用时按 GUID 重新解析接口索引，避免网卡重编号导致误操作。

**批量操作部分失败**：查看操作记录的逐项错误与当前快照。系统路由变化不是数据库事务，已经成功的条目仍会保留。静态路由替换失败会尝试恢复原记录；无法确认现场状态时不会覆盖其他记录。

**系统自动路由重新出现**：DHCP、网络栈或其他软件可能自动生成路由。应用展示核验结果，不反复删除。
