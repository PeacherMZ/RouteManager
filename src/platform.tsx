import { createContext, useContext } from 'react';
export interface PlatformInfo {
  os: 'windows' | 'macos'; route_write: boolean; persistent_routes: boolean; metric: boolean;
  privilege: 'startup' | 'on_demand';
}
export const windowsPlatform: PlatformInfo = { os: 'windows', route_write: true, persistent_routes: true, metric: true, privilege: 'startup' };
export const PlatformContext = createContext<PlatformInfo>({ ...windowsPlatform, route_write: false });
export const usePlatform = () => useContext(PlatformContext);
