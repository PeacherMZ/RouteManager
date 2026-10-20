import { describe, expect, it } from 'vitest';
import { activeRecord, copyConfig, filterRoutes, fromRoute, gatewayOptions, patchConfigs, persistence, validateConfigs, validateDraft } from '../src/domain';
import type { Library, RouteConfig, RouteView } from '../src/types';
const config: RouteConfig = {id:'c',name:'示例网络',prefix:'203.0.113.0/25',gateway:'192.0.2.1',interface_id:null,metric:null,persistent:true,comment:''};
const library: Library = {routes:[config],groups:[]};
const row: RouteView = {key:'r',config_ids:['c'],ambiguous_config_ids:[],ownership:'managed',created_by_app:false,records:[{
  family:'IPv4',prefix:config.prefix,gateway:config.gateway,interface_index:7,interface_id:'guid',interface_alias:'Ethernet',route_metric:10,interface_metric:25,protocol:'NetMgmt',store:'ActiveStore',
}]};
describe('路由界面语义',()=>{
  it('区分临时、持久和仅持久',()=>{
    expect(persistence(row)).toBe('临时');
    const persistent={...row,records:[...row.records,{...row.records[0],store:'PersistentStore'}]};
    expect(persistence(persistent)).toBe('持久');
    expect(persistence({...row,records:[persistent.records[1]]})).toBe('仅持久记录');
  });
  it('组合搜索、接口和归属筛选',()=>{
    const filters={search:'示例',owner:'managed',family:'IPv4',network:'7',persistent:'临时'};
    expect(filterRoutes([row],filters,library)).toHaveLength(1);
    expect(filterRoutes([row],{...filters,network:'8'},library)).toHaveLength(0);
    expect(filterRoutes([row],{...filters,family:'IPv6'},library)).toHaveLength(0);
  });
  it('修改路由从实际值开始并保留已关联的配置 ID',()=>{
    const draft=fromRoute(row,library);
    expect(draft.id).toBe('c');expect(draft.metric).toBe(10);expect(draft.persistent).toBe(false);
  });
  it('有效 metric 的主记录取活动库',()=>{
    expect(activeRecord({...row,records:[{...row.records[0],store:'PersistentStore',route_metric:200},row.records[0]]}).route_metric).toBe(10);
  });
  it.each(['::/0','256.1.1.0/24','203.0.113.0/33','203.0.113.0','0203.0.113.0/24'])('拒绝无效 IPv4 前缀 %s',prefix=>{
    expect(validateDraft({...config,prefix})).not.toBeNull();
  });
  it('验证 metric、默认路由与直连网关',()=>{
    expect(validateDraft({...config,prefix:'0.0.0.0/0',gateway:'0.0.0.0',metric:0})).toBeNull();
    expect(validateDraft({...config,metric:65536})).not.toBeNull();
    expect(validateDraft({...config,metric:1.5})).not.toBeNull();
  });
});

describe('配置复制、批量修改与网关候选', () => {
  it('复制保留参数，生成独立 ID 和不冲突的副本名称', () => {
    const first = copyConfig(config, [config]);
    const second = copyConfig(config, [config, first]);
    expect(first).toEqual({ ...config, id: first.id, name: '示例网络（副本）' });
    expect(new Set([config.id, first.id, second.id]).size).toBe(3);
    expect(second.name).toBe('示例网络（副本） 2');
  });
  it('批量修改仅影响选中配置及指定字段，支持清空值', () => {
    const other = { ...config, id: 'other', prefix: '198.51.100.0/24', metric: 20 };
    const original = [{ ...config, metric: 10, comment: '原备注' }, other];
    const updated = patchConfigs(original, [config.id], { gateway: '192.0.2.254', metric: null, interface_id: null, comment: '' });
    expect(updated[0]).toEqual({ ...original[0], gateway: '192.0.2.254', metric: null, interface_id: null, comment: '' });
    expect(updated[1]).toBe(other);
    expect(original[0].comment).toBe('原备注');
    expect(original[0].metric).toBe(10);
  });
  it('保存前拦截规范化后重复的路由，保留不同接口或作用域', () => {
    const duplicate = { ...config, id: 'copy', name: '副本', prefix: '203.0.113.80/25' };
    expect(validateConfigs([config, duplicate])).toContain('路由重复');
    expect(validateConfigs([config, { ...duplicate, interface_id: 'windows:11111111-1111-4111-8111-111111111111' }])).toBeNull();
    expect(validateConfigs([{ ...config, prefix: '0.0.0.0/0' }, { ...duplicate, prefix: '203.0.113.80/0' }])).toContain('路由重复');
    const scoped = { ...config, persistent: false, interface_id: 'macos:en0:11111111-1111-4111-8111-111111111111', scope: 'scoped' as const };
    expect(validateConfigs([scoped, { ...scoped, id: 'global', scope: 'unscoped' }])).toBeNull();
    expect(validateConfigs(patchConfigs([scoped], [scoped.id], { persistent: true }))).toBeNull();
    expect(patchConfigs([scoped], [scoped.id], { persistent: true })[0].scope).toBeNull();
    expect(validateConfigs(patchConfigs([scoped], [scoped.id], { persistent: true, scope: 'scoped' }))).toContain('仅适用于');
  });
  it('合并活动与持久记录，去重 IPv4 网关并保留全部接口提示', () => {
    const record = row.records[0];
    expect(gatewayOptions([{ ...row, records: [record, { ...record, store: 'PersistentStore' },
      { ...record, interface_alias: 'VPN' }, { ...record, gateway: '0.0.0.0' },
      { ...record, gateway: '192.0.2.2', store: 'PersistentStore' },
      { ...record, gateway: '192.0.2.10' }, { ...record, family: 'IPv6', gateway: 'fe80::1' },
      { ...record, gateway: '999.0.0.1' },
    ] }])).toEqual([
      { address: '192.0.2.1', interfaces: ['Ethernet', 'VPN'] },
      { address: '192.0.2.2', interfaces: ['Ethernet'] },
      { address: '192.0.2.10', interfaces: ['Ethernet'] },
      { address: '0.0.0.0', interfaces: ['Ethernet'] },
    ]);
  });
});
