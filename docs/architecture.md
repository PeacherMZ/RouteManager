# 架构与接口

## 分层

- `src/`：React/Fluent UI，界面、筛选、编辑表单；不直接访问系统命令或数据库。
- `src-tauri/src/model.rs`：实际记录、配置意图、匹配结果、计划与执行结果的独立类型。
- `routes.rs`：纯函数规范化、校验、匹配和状态计算。
- `db.rs` + `migrations/`：SQLite、版本迁移、旧 YAML 转换、备份及操作记录。
- `service.rs`：系统变更规划、预条件检查、串行执行、核验及受控恢复。
- `system.rs` + `powershell/routes.ps1`：Windows NetTCPIP 适配器；测试使用同一接口的内存实现。
- `hosts.rs`：编码保留、原文件指纹校验、备份和 Windows 原子替换。

## 系统边界

Tauri 仅注册固定命令：get_snapshot、get_library、save_library、preview_operation、execute_operation、get_history、import_yaml、export_yaml、read_hosts、save_hosts、get_settings、save_setting。

所有文件路径由 Rust 确定，前端仅提交文件内容或业务参数。PowerShell 脚本在编译期嵌入；采用固定 UTF-16 EncodedCommand 和 UTF-8 JSON stdin，不把用户输入拼成脚本。桌面端复用一个隐藏的私有 PowerShell 进程，以单行 JSON 顺序请求/响应，无监听端口；CIM 每次重新查询。管道读写在线程中执行，45 秒超时后销毁进程并报告不确定状态，不自动重放请求。下次请求重建进程；普通业务错误通过 JSON 返回，可继续使用进程。错误流不入协议，避免阻塞；关闭时释放子进程及线程。脚本保留单次 stdin 模式用于诊断。

发布版 CSP 仅允许本地资源与 Tauri IPC，没有通用 shell 插件、远程页面或远程 SQL 权限。清除、编辑和新增在 Rust 和 PowerShell 两层限制为 IPv4。Windows manifest 为 requireAdministrator；本机同一会话中只允许一个管理器实例。

## 路由身份与状态

合并键为：地址族 + 规范化目标前缀 + 网关 + 接口 GUID。系统没有 GUID 的只读记录退回接口索引识别；缺少可靠网卡信息时不能用于新建路由。活动与持久记录分别保留自己的 metric 和协议。

配置有 GUID 时准确匹配；旧配置没有 GUID 时仅在目标与网关唯一命中一个接口时关联，多个接口命中则标记 ambiguous。新建缺少 GUID 时只允许根据网关所在本地 IPv4 网段唯一推断网卡，否则要求选择。

配置状态：active、inactive、persistent_only、drifted、ambiguous。持久属性与显式 metric 不同属于 drifted；未指定 metric 时不强制改写已有数值。

兼容旧 route.exe -p 创建的 ifIndex=0、无 GUID 持久记录：存在唯一活动接口时仅设置逻辑关联，原始 ifIndex/GUID 保持不变用于精确写入。多个活动接口共享无接口持久记录时视为歧义，即使某配置已经绑定 GUID 也不认领共享持久记录。删除核验按物理记录检查，不能因为活动记录消失导致逻辑关联消失，就把残留持久记录误报为已删除。

系统返回的记录是事实来源；数据库没有“已启用”字段假冒实时状态。来源协议和历史创建记录不参与所有权伪造。

## 变更协议

1. preview_operation 接收操作意图，读取当前实际状态，生成后端保存的 OperationPlan。
2. execute_operation 只接受计划 ID，不能接收前端改写的执行指令。计划 10 分钟有效；生成新计划或编辑配置会使旧计划失效。
3. 执行前比较配置库指纹、目标记录、接口可用状态；每项执行前再次核对。
4. 先持久化 running 日志和 before 状态，再执行。系统修改串行处理，每项都重新读取核验。
5. 相同状态直接 skip；全部 skip 的批次共用执行时新读的快照，无写入，也不逐项重复读表。混合批次仍逐项重读，skip 项复用该次读取验证。metric 更新使用 Set-NetRoute；目标、网关、接口或持久属性变化使用受控替换。
6. 删除先处理持久记录，再重新查询活动记录。新建持久路由省略 PolicyStore（Windows 默认写两份）；临时路由显式 ActiveStore。
7. 新路由只有核验通过才保存配置和创建证据；部分失败单独展示。系统成功而配置保存失败会明确报告，不假称原子成功。
8. 替换失败时只尝试恢复可识别、未发布、无限生命周期且有接口 GUID 的 NetMgmt 静态记录；历史无接口或特殊属性记录不伪造恢复。若出现不明新记录则不覆盖。恢复结果单独返回。
9. 崩溃中断的 running 日志在下次启动标记 interrupted，避免误报成功。

外部程序仍可在最后核验后改变网络状态，程序无法对 Windows 全局路由表取得事务锁；自动刷新和冲突提示用于反映这一事实。

## 界面刷新与分组

后台轮询只读取路由快照，不反复加载配置及 500 条历史；编辑和变更预览期间暂停自动刷新。读取按请求独立回显，操作完成后保证在先前刷新结束后发起新的核对。配置修改使用本地修订号屏蔽旧响应；路由配置保存后后台核对归属，期间显示状态待同步；纯分组保存不读取系统快照。同一路由可加入多个分组，批量添加按配置列表顺序追加并去重，不改变原有成员顺序，不执行系统操作。

## 存储

SQLite 使用外键、事务、完整同步和版本号。配置、分组及有序成员独立存储；操作结果保留 before/after、错误和恢复说明。历史页面加载最近 500 次，数据库仍保留全部记录。legacy_imported 标记与首批配置同一事务提交。数据库升级或导入前使用 SQLite backup API 生成一致备份。

hosts 支持 UTF-8、UTF-8 BOM、UTF-16 LE/BE 和可识别系统 ANSI 代码页；无法无损转换时拒绝写入。保存保留换行，使用 ReplaceFileW 保留 Windows 元数据。
