import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (pkg.version !== config.version || cargo !== pkg.version) throw new Error('Package, Cargo and Tauri versions must match');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Version tag does not match application version');
const windows = process.platform === 'win32';
if (!windows && process.platform !== 'darwin') throw new Error('Build on Windows or macOS');
const target = windows ? 'x86_64-pc-windows-msvc' : 'aarch64-apple-darwin';
process.env.CARGO_TARGET_DIR ??= join(root, 'artifacts', 'cargo');
const output = join(root, 'artifacts', 'release');
mkdirSync(output, { recursive: true });
function run(program, args, extra = {}) {
  // cmd is only used for the fixed pnpm executable on Windows; no user command text.
  const result = spawnSync(program, args, { stdio: 'inherit', env: process.env, ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status})`);
}
function pnpm(args) { if (windows) run('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`]); else run('pnpm', args); }
pnpm(['install', '--frozen-lockfile']);
if (!process.argv.includes('--skip-tests')) {
  pnpm(['test']);
  run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--locked']);
  if (windows) run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/windows-adapter.ps1']);
}
if (!windows) {
  const iconset = join(root, 'artifacts', 'icon.iconset'); mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), 'src-tauri/icons/icon.png', '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
  }
  run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', 'src-tauri/icons/icon.icns']);
}
const args = ['tauri', 'build', '--no-bundle', '--target', target, '--', '--locked'];
pnpm(args);
const release = join(process.env.CARGO_TARGET_DIR, target, 'release');
if (windows) {
  const app = join(root, 'artifacts', 'app'); mkdirSync(app, { recursive: true });
  copyFileSync(join(release, 'RouteManager.exe'), join(app, 'RouteManager.exe'));
  // A CI runner has no local user launch entry; WScript shortcut saving also
  // depends on its locale. Preserve the shortcut only for local builds.
  if (!process.env.CI) run('pwsh', ['-File', 'scripts/Create-Shortcut.ps1']);
}
if (windows && process.argv.includes('--app-only')) {
  console.log(`Application compiled; installer intentionally not generated: ${release}`);
  process.exit(0);
}
pnpm(['tauri', 'bundle', '--target', target]);
function checksum(installer) {
  writeFileSync(`${installer}.sha256`, `${createHash('sha256').update(readFileSync(installer)).digest('hex')}  ${installer.split(/[\\/]/).at(-1)}\n`);
}
let installer;
if (windows) {
  const candidates = readdirSync(join(release, 'bundle', 'nsis')).filter(f => f === `${config.productName}_${pkg.version}_x64-setup.exe`);
  if (candidates.length !== 1) throw new Error('Expected one current-version NSIS installer');
  installer = join(output, `RouteManager_${pkg.version}_windows_x64-setup.exe`);
  copyFileSync(join(release, 'bundle', 'nsis', candidates[0]), installer);
  checksum(installer);
  console.log(`Built offline installer: ${installer}`);
  // Reuse the compiled application; only the WebView2 distribution mode changes.
  pnpm(['tauri', 'bundle', '--target', target, '--config', 'src-tauri/tauri.windows-online.conf.json']);
  installer = join(output, `RouteManager_${pkg.version}_windows_x64-online-setup.exe`);
  copyFileSync(join(release, 'bundle', 'nsis', candidates[0]), installer);
  // Keep the local runnable binary byte-identical after Tauri's bundle-type patch.
  copyFileSync(join(release, 'RouteManager.exe'), join(root, 'artifacts', 'app', 'RouteManager.exe'));
} else {
  const app = join(release, 'bundle', 'macos', '路由管理器.app');
  const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
  const helper = join(app, 'Contents', 'Resources', 'route-manager-helper');
  run('/usr/bin/codesign', ['--force', '--options', 'runtime', '--sign', identity, helper]);
  run('/usr/bin/codesign', ['--force', '--options', 'runtime', '--sign', identity, app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  run(helper, ['self-test']);
  if (process.argv.includes('--app-only')) {
    console.log(`Application bundle built; PKG intentionally not generated: ${app}`);
    process.exit(0);
  }
  const staging = join(root, 'artifacts', 'pkg-staging'); mkdirSync(staging, { recursive: true });
  const scripts = join(staging, 'scripts'); mkdirSync(scripts, { recursive: true });
  copyFileSync('scripts/macos/preinstall', join(scripts, 'preinstall'));
  run('/bin/chmod', ['755', join(scripts, 'preinstall')]);
  const component = join(staging, 'application.pkg');
  const plist = join(staging, 'components.plist');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><dict><key>RootRelativeBundlePath</key><string>路由管理器.app</string><key>BundleIsRelocatable</key><false/><key>BundleIsVersionChecked</key><true/><key>BundleHasStrictIdentifier</key><true/><key>BundleOverwriteAction</key><string>upgrade</string></dict></array></plist>`);
  run('/usr/bin/pkgbuild', ['--component', app, '--component-plist', plist, '--install-location', '/Applications', '--identifier', `${config.identifier}.pkg`, '--version', pkg.version, '--scripts', scripts, component]);
  const distribution = join(staging, 'Distribution.xml');
  writeFileSync(distribution, `<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
<title>路由管理器 ${pkg.version}</title><options customize="never" hostArchitectures="arm64"/>
<volume-check><allowed-os-versions><os-version min="13.0"/></allowed-os-versions></volume-check>
<domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/>
<installation-check script="checkVersion()"/><script><![CDATA[
function checkVersion() {
  var installed = system.files.plistAtPath('/Applications/路由管理器.app/Contents/Info.plist');
  if (installed && system.compareVersions(installed.CFBundleShortVersionString, '${pkg.version}') > 0) {
    my.result.type = 'Fatal'; my.result.message = '已安装更新版本，不能降级。'; return false;
  } return true;
}
]]></script><choices-outline><line choice="app"/></choices-outline>
<choice id="app" visible="false"><pkg-ref id="${config.identifier}.pkg"/></choice>
<pkg-ref id="${config.identifier}.pkg" version="${pkg.version}" onConclusion="none">application.pkg</pkg-ref>
</installer-gui-script>`);
  installer = join(output, `RouteManager_${pkg.version}_macos_arm64.pkg`);
  run('/usr/bin/productbuild', ['--distribution', distribution, '--package-path', staging, ...(process.env.APPLE_INSTALLER_IDENTITY ? ['--sign', process.env.APPLE_INSTALLER_IDENTITY] : []), installer]);
  if (process.env.APPLE_NOTARY_PROFILE) {
    run('/usr/bin/xcrun', ['notarytool', 'submit', installer, '--keychain-profile', process.env.APPLE_NOTARY_PROFILE, '--wait']);
    run('/usr/bin/xcrun', ['stapler', 'staple', installer]);
  }
}
checksum(installer);
console.log(`Built: ${installer}`);
