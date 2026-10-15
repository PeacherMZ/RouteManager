import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Release tag/version mismatch');
const names = [`RouteManager_${version}_windows_x64-online-setup.exe`, `RouteManager_${version}_windows_x64-setup.exe`, `RouteManager_${version}_macos_arm64.pkg`];
const files = readdirSync('artifacts/release');
if (files.length !== names.length * 2 || names.some(n => !files.includes(n) || !files.includes(`${n}.sha256`))) throw new Error('Expected Windows online/offline and macOS installers with checksums');
for (const name of names) {
  const digest = createHash('sha256').update(readFileSync(`artifacts/release/${name}`)).digest('hex');
  if (readFileSync(`artifacts/release/${name}.sha256`, 'utf8').trim() !== `${digest}  ${name}`) throw new Error(`Checksum mismatch: ${name}`);
}
function gh(args, allowFailure = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error || (result.status !== 0 && !allowFailure)) throw new Error(result.stderr || String(result.error));
  return result;
}
const existing = gh(['release', 'view', tag, '--json', 'isDraft'], true);
if (existing.status === 0 && !JSON.parse(existing.stdout).isDraft) throw new Error('Refusing to replace an already published release');
const notes = `路由管理器 ${version}\n\nWindows 10/11 x64：推荐 online-setup.exe 轻量包，缺少 WebView2 时需要联网下载；setup.exe 为完整离线包，适合断网部署。\nmacOS 13+ Apple Silicon：PKG 安装到 Applications。\n\n覆盖安装前请退出程序。用户数据保存在各平台用户目录，升级和卸载保留数据。不自动迁移旧便携版目录，可手动导入 YAML。\n\n当前 Windows 安装包未签名；macOS 应用使用 ad-hoc 签名，安装包未公证，首次运行可能需要系统安全设置放行。\n\n本草稿由两平台 CI 自动生成。公开发布前请完成 docs/acceptance.md 中的实机、覆盖安装及重启验收。\n`;
writeFileSync('artifacts/release-notes.md', notes);
if (existing.status !== 0) gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', `路由管理器 ${version}`, '--notes-file', 'artifacts/release-notes.md', ...files.map(f => `artifacts/release/${f}`)]);
else {
  gh(['release', 'edit', tag, '--draft', '--notes-file', 'artifacts/release-notes.md']);
  gh(['release', 'upload', tag, '--clobber', ...files.map(f => `artifacts/release/${f}`)]);
}
