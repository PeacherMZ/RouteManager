import { invoke, isTauri } from '@tauri-apps/api/core';
import type { HostsDocument, Library, OperationPlan, OperationResult, PlanRequest, RouteSnapshot, Settings } from './types';
export const desktop = isTauri();
export const demo = !desktop && import.meta.env.DEV && new URLSearchParams(location.search).get('demo') === '1';
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (demo) {
    const { demoCall } = await import('./demo');
    return demoCall(command, args) as Promise<T>;
  }
  if (!desktop) throw new Error('当前为浏览器预览，系统操作不可用。请通过桌面程序打开。');
  return invoke<T>(command, args);
}
export const api = {
  snapshot: () => call<RouteSnapshot>('get_snapshot'),
  library: () => call<Library>('get_library'),
  saveLibrary: (library: Library) => call<Library>('save_library', { library }),
  preview: (request: PlanRequest) => call<OperationPlan>('preview_operation', { request }),
  execute: (id: string) => call<OperationResult>('execute_operation', { id }),
  history: () => call<OperationResult[]>('get_history'),
  importYaml: (text: string) => call<Library>('import_yaml', { text }),
  exportYaml: () => call<string>('export_yaml'),
  readHosts: () => call<HostsDocument>('read_hosts'),
  saveHosts: (content: string, fingerprint: string) => call<HostsDocument>('save_hosts', { content, fingerprint }),
  settings: () => call<Settings>('get_settings'),
  saveSetting: (key: string, value: unknown) => call<void>('save_setting', { key, value }),
};
