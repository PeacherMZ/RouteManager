import { describe, expect, it } from 'vitest';
import { activeRecord, filterRoutes, fromRoute, persistence, validateDraft } from '../src/domain';
import type { Library, RouteConfig, RouteView } from '../src/types';
const config: RouteConfig = {id:'c',name:'示例网络',prefix:'203.0.113.0/25',gateway:'192.0.2.1',interface_guid:null,metric:null,persistent:true,comment:''};
const library: Library = {routes:[config],groups:[]};
const row: RouteView = {key:'r',config_ids:['c'],ambiguous_config_ids:[],ownership:'managed',created_by_app:false,records:[{
  family:'IPv4',prefix:config.prefix,gateway:config.gateway,interface_index:7,interface_guid:'guid',interface_alias:'Ethernet',route_metric:10,interface_metric:25,protocol:'NetMgmt',store:'ActiveStore',
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
