import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), write: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read, readdirSync: mocks.list, writeFileSync: mocks.write }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));

const version = '9.8.7';
const tag = `v${version}`;
const title = `RouteManager ${version}`;
const names = [
  `RouteManager_${version}_windows_x64-online-setup.exe`,
  `RouteManager_${version}_windows_x64-setup.exe`,
  `RouteManager_${version}_macos_arm64.pkg`,
];

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('GITHUB_REF_NAME', tag);
  const payload = Buffer.from('synthetic installer fixture');
  const digest = createHash('sha256').update(payload).digest('hex');
  mocks.list.mockReturnValue(names.flatMap(name => [name, `${name}.sha256`]));
  mocks.read.mockImplementation((path: string) => {
    if (path === 'package.json') return JSON.stringify({ version });
    const name = path.replace('artifacts/release/', '');
    if (name.endsWith('.sha256')) return `${digest}  ${name.slice(0, -7)}\n`;
    if (names.includes(name)) return payload;
    throw new Error(`Unexpected read: ${path}`);
  });
  mocks.spawn.mockImplementation((_command: string, args: string[]) => ({
    status: args[1] === 'view' ? 1 : 0, stdout: '', stderr: '',
  }));
});
afterEach(() => vi.unstubAllEnvs());

test('new release uses the English product name in its title and notes', async () => {
  await import('../scripts/release.mjs');
  expect(mocks.spawn).toHaveBeenCalledWith('gh', [
    'release', 'create', tag, '--verify-tag', '--draft', '--title', title,
    '--notes-file', 'artifacts/release-notes.md',
    ...names.flatMap(name => [`artifacts/release/${name}`, `artifacts/release/${name}.sha256`]),
  ], { encoding: 'utf8' });
  expect(mocks.write).toHaveBeenCalledWith('artifacts/release-notes.md', expect.stringMatching(/^RouteManager 9\.8\.7\n/));
});

test('retry updates the current draft title without creating another release', async () => {
  mocks.spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ isDraft: true }), stderr: '' });
  await import('../scripts/release.mjs');
  expect(mocks.spawn.mock.calls.map(call => call[1][1])).toEqual(['view', 'edit', 'upload']);
  expect(mocks.spawn).toHaveBeenCalledWith('gh', [
    'release', 'edit', tag, '--draft', '--title', title, '--notes-file', 'artifacts/release-notes.md',
  ], { encoding: 'utf8' });
});

test('published releases remain unchanged', async () => {
  mocks.spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ isDraft: false }), stderr: '' });
  await expect(import('../scripts/release.mjs')).rejects.toThrow('Refusing to replace an already published release');
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.write).not.toHaveBeenCalled();
});
