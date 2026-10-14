# 项目约束

## 维护本文件
- 每次更新项目时同步检查并维护 AGENTS.md：项目定位、目录、关键约束或开发入口变化时更新对应内容，删除过时信息；无相关变化时不为留痕追加内容。
- 只保留必要、稳定的项目摘要，控制在约 60 行以内。实现细节放 docs/，不堆积变更日志、测试结果、排障过程或重复文档。
- 用户明确要求优先；已获得的授权不重复询问。

## 项目与目录
- Windows 10/11 x64 便携式路由管理器；Tauri 2 + Rust + React/TypeScript + Fluent UI + SQLite。中文紧凑界面，支持深浅主题。
- IPv4 可管理，IPv6 只读；正式程序启动即提权，保持本地资源与受限 IPC。
- src/：界面；src-tauri/：后端、数据库迁移和固定 PowerShell 脚本；scripts/：构建及启动工具；tests/ 与 src-tauri/tests/：测试。
- artifacts/：构建与运行产物；data/：用户数据、备份及导出；legacy/：旧版归档；.tools/：开发工具链。
- 保持前后端分层；修改 IPC 参数或模型时同步更新 TypeScript 类型和调用。

## 公开仓库约束
- 本仓库公开发布；禁止跟踪个人信息、凭据、真实路由/hosts、内部地址或域名、设备标识、绝对用户路径及本机诊断资料。
- data/、legacy/、artifacts/、.tools/、依赖、构建产物、截图、日志和代理本地状态必须保持忽略；不能用 git add -f 绕过，也不能仅靠 .gitignore 判断安全。
- 示例与测试仅用独立虚构数据、文档保留地址和合成 GUID；不得读取私人 legacy/ 或 data/，不得把真实数据复制到测试或文档。
- 每次提交/推送前检查 git status、git diff --cached 与完整暂存文件清单，扫描敏感内容及二进制元数据；新增文件类型先核对忽略规则。提交身份仅使用明确授权的公开身份。

## 核心约束
- 实际路由以系统快照为准，配置操作不隐式修改系统路由。“受管理”表示配置命中，不等于创建来源。
- 精确匹配前缀、网关和接口身份，优先 GUID；接口歧义不猜测。活动与持久记录分别核对。
- 旧 route -p 的无接口持久记录仅在活动接口唯一时关联，保留物理标识；删除按物理记录核验，不能漏掉持久残留。
- 系统修改先预览、执行前重读核对、串行执行、执行后核验；部分失败和恢复失败如实报告，不覆盖未知变化。
- 清除受管理路由只删除准确命中项及其持久记录，保留配置和其他路由。
- 使用固定脚本与结构化 JSON，不拼接用户输入执行命令。测试默认使用模拟路由、独立数据库和临时 hosts；真实系统写入须属于明确授权范围。
- PowerShell 私有进程复用只减少启动开销，不缓存系统快照；传输失败不得自动重放写入。纯分组保存不读取系统路由，刷新不得覆盖较新的配置。
- 不以修复或测试为由重置 data/ 或修改 legacy/ 原文件。数据库迁移需事务与备份；hosts 保存需备份、冲突检查及编码/换行保留。
- 支持中文和空格路径；清理限定于明确的产物目录。测试后清理自建进程、调试端口和临时副本。

## 开发与验证
- 优先使用现有工具链和 pnpm，保持锁文件同步；安装依赖使用 pnpm install --frozen-lockfile。
- 前端：pnpm test、pnpm build；界面交互变更按需运行 pnpm exec playwright test。
- Rust：先加载 scripts/Environment.ps1，再运行 cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked。
- PowerShell 适配变更运行 tests/windows-adapter.ps1 契约测试（Windows PowerShell 5.1）。
- 交付可运行更新使用 pwsh -File scripts/Build.ps1，保持 artifacts/app/RouteManager.exe 与根目录快捷方式同步；构建受阻须明确说明。
- 按变更范围验证；纯文档修改无需重建。模拟验证不能替代真实写入和重启验收。
- 存在 .codegraph/ 时优先使用 CodeGraph 定位代码；不存在时使用 rg，不自行建立索引。普通搜索排除依赖和生成目录。

## 按需查阅
- [README.md](README.md)：运行、构建及常见问题。
- [架构说明](docs/architecture.md)：匹配、持久记录、接口与数据细节。
- [验收说明](docs/acceptance.md)：测试场景；[验证记录](docs/verification.md)只保留可公开的验证范围，不包含本机网络信息。
