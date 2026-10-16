# 构建与发布

项目仓库为 [PeacherMZ/RouteManager](https://github.com/PeacherMZ/RouteManager)，后续 Release 标题统一为 `RouteManager X.Y.Z`，已有 Release 保持原名称。仓库重命名不改变应用标识、安装路径或用户数据目录。

## 无凭据默认流程

版本统一在 package.json、Cargo.toml、tauri.conf.json 中更新；Cargo.lock 的项目版本同步更新。首次跨平台版本为 2.1.0。

工作流 `.github/workflows/build.yml` 使用固定提交的 Actions、Node 24、Rust 1.99.0 和冻结锁文件。Windows runner 为 windows-2022，Apple Silicon runner 为 macos-15；最低运行系统仍需 Windows 10、macOS 13 实机验证。

工作流仅由版本标签推送（`v*`）或 `workflow_dispatch` 手动触发；普通分支推送（包括合入 main）和 PR 不自动运行。需要验证分支时，在 GitHub Actions 中选择本工作流，点击 Run workflow 并选择分支；手动运行只测试和打包，安装包保存在 Actions artifacts，不创建 Release 草稿。

推送与应用版本一致的 `vX.Y.Z` 标签后，自动运行双平台测试和打包，再触发依赖两平台成功的草稿发布任务。该任务检查版本、三份安装包和三个校验文件，只有它有仓库写权限。失败不会公开 Release；重跑仅允许更新草稿，拒绝覆盖已经发布的版本。

安装包和用户数据分离：Windows NSIS 默认 `C:\Program Files\RoutingTableManager`（覆盖升级沿用已有安装目录），macOS PKG 固定 `/Applications/路由管理器.app`。安装脚本不修改路由、hosts、用户数据库或启动项。macOS 组件禁止重定位；安装器在发现运行进程或较高版本时拒绝继续。

Windows 自定义 NSIS 模板基于锁定 CLI 2.12.2 的上游模板，保留 MIT 许可证。修改点为去除删除用户数据的选项/代码、禁止强制关闭进程和降级安装。升级 Tauri CLI 时须重新核对模板变量与安装验收。

## 后续签名接入

当前无需任何签名 Secrets：Windows 不签名，macOS 使用 ad-hoc 签名。SHA-256 用于完整性核对，不代表发布者身份认证。

有凭据后在受信任的 tag 工作流中增加签名准备/清理步骤，不能向 fork PR 暴露 Secrets：

- Windows：将证书与密码存为 GitHub Secrets，在构建 runner 临时导入证书，向 Tauri Windows 配置提供 certificateThumbprint、digestAlgorithm 和受信任时间戳地址；构建后移除导入证书。不得把 PFX、私钥、密码或本机证书指纹提交源码。
- macOS：把 Developer ID Application 和 Developer ID Installer 的 P12/密码存为 Secrets，导入临时 keychain，设置 `APPLE_SIGNING_IDENTITY`、`APPLE_INSTALLER_IDENTITY`。构建入口会依次签名助手、应用和 PKG。
- 将 App Store Connect 公证凭据存为 Secrets，使用 `xcrun notarytool store-credentials` 写入同一临时 keychain，设置 `APPLE_NOTARY_PROFILE`。构建入口等待公证并 staple 安装包后计算最终校验值。无公证 profile 时不会声称包已公证。
- 工作流 `always()` 清理临时 keychain、证书及凭据文件；不要关闭系统 Gatekeeper 或修改 sudoers。

正式发布需人工核对 docs/acceptance.md，特别是原生持久路由重启恢复、覆盖安装保留数据、跨账户 UAC 和未签名包首次运行体验。

## Windows 安装包体积

统一构建一次编译、两次封装：`windows_x64-online-setup.exe` 为推荐轻量包，使用 Tauri `downloadBootstrapper`，仅缺少 WebView2 时联网下载；`windows_x64-setup.exe` 保留完整离线运行时，供断网部署。两种包具有相同应用标识、版本、安装路径和数据保护规则，可互相覆盖升级。完整离线包的体积主要来自 WebView2，不能在删除运行时后仍宣称支持无运行时的离线安装。

发布任务要求 Windows 两种包、macOS PKG 及各自 SHA-256 全部存在。配置见 `src-tauri/tauri.windows-online.conf.json`；安装方式依据 [Tauri 官方文档](https://v2.tauri.app/distribute/windows-installer/)。

CI 不创建开发用的根目录快捷方式；本地 Windows 构建仍更新该快捷方式。macOS 15 runner 用于匹配 Playwright 的受支持 WebKit，应用部署目标仍为 macOS 13。
