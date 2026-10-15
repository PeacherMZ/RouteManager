import { windowsPlatform } from './platform';
import type { Library, OperationPlan, OperationResult, PlanRequest, RouteRecord, RouteSnapshot, RouteView, Settings, HostsDocument } from './types';

// Entirely synthetic fixtures: documentation addresses and made-up interface GUIDs.
const macDemo = new URLSearchParams(location.search).get('demo_platform') === 'macos';
const ethernet = macDemo ? 'macos:en0:11111111-1111-4111-8111-111111111111' : 'windows:11111111-1111-4111-8111-111111111111';
const vpn = macDemo ? 'macos:utun0:-' : 'windows:22222222-2222-4222-8222-222222222222';
let library: Library = {
  routes: [
    {id:'dev',name:'示例网络',prefix:'203.0.113.0/25',gateway:'192.0.2.254',interface_id:ethernet,metric:10,persistent:true,comment:'虚构文档示例网段'},
    {id:'vdi',name:'示例主机',prefix:'203.0.113.80/32',gateway:'192.0.2.254',interface_id:ethernet,metric:5,persistent:true,comment:'虚构主机示例'},
    {id:'lab',name:'测试实验室',prefix:'198.51.100.0/25',gateway:'192.0.2.254',interface_id:ethernet,metric:10,persistent:true,comment:'需要时应用'},
  ],
  groups:[{id:'work',name:'示例网络',routes:['dev','vdi']},{id:'test',name:'测试环境',routes:['lab']}],
};
const record = (prefix: string, gateway: string, protocol = 'NetMgmt', metric = 10, guid = ethernet): RouteRecord => ({
  family:prefix.includes(':')?'IPv6':'IPv4',prefix,gateway,protocol,route_metric:metric,interface_metric:25,
  interface_index:guid===ethernet?7:18,interface_id:guid,interface_alias:guid===ethernet?'以太网':'示例 VPN',store:'ActiveStore',
});
const key = (r: RouteRecord) => [r.family,r.prefix,r.gateway,r.interface_id].join('|');
const row = (r: RouteRecord, persistent=false): RouteView => ({key:key(r),records:persistent?[r,{...r,store:'PersistentStore'}]:[r],config_ids:[],ambiguous_config_ids:[],ownership:'other',created_by_app:false});
let rows = [
  row(record('0.0.0.0/0','192.0.2.1','Dhcp',0)),
  row(record('203.0.113.0/25','192.0.2.254'),true),
  row(record('203.0.113.80/32','192.0.2.254','NetMgmt',5),true),
  row(record('198.51.100.128/25','198.51.100.129','NetMgmt',20,vpn)),
  row(record('127.0.0.0/8','0.0.0.0','Local',256)),
  row(record('192.0.2.0/24','0.0.0.0','Local',256)),
  row(record('192.0.2.100/32','0.0.0.0','Local',256)),
  row(record('192.0.2.255/32','0.0.0.0','Local',256)),
  row(record('224.0.0.0/4','0.0.0.0','Local',256)),
  row(record('::/0','fe80::1','Icmp',256)),
  row(record('fe80::/64','::','Local',256)),
];
const interfaces = [{guid:ethernet,index:7,alias:'以太网',status:'Up',addresses:['192.0.2.100/24']},{guid:vpn,index:18,alias:'示例 VPN',status:'Up',addresses:['198.51.100.130/25']}];
let settings: Settings = {theme:'light',refresh_seconds:5,data_dir:macDemo ? '~/Library/Application Support/com.local.route-manager（演示）' : '%LOCALAPPDATA%\\com.local.route-manager（演示）',version:'2.1.0',backups_dir:'用户目录/backups（演示）',exports_dir:'用户目录/exports（演示）',platform:macDemo ? {...windowsPlatform,os:'macos',metric:false,privilege:'on_demand'} : windowsPlatform};
const history: OperationResult[] = [];
let pending: OperationPlan | null = null;
let hosts: HostsDocument = {content:'# 本机域名映射（演示）\r\n127.0.0.1 localhost\r\n::1 localhost\r\n',fingerprint:'demo-0',encoding:'UTF-8',newline:'CRLF',path:'C:\\Windows\\System32\\drivers\\etc\\hosts（演示）'};
function snapshot(): RouteSnapshot {
  rows = rows.map(r => {
    const match = library.routes.filter(c => c.prefix===r.records[0].prefix && c.gateway===r.records[0].gateway && (!c.interface_id || c.interface_id===r.records[0].interface_id));
    return {...r, config_ids:match.map(c=>c.id), ownership:match.length?'managed':['Local','Dhcp'].includes(r.records[0].protocol)?'system':'other'};
  });
  return {captured_at:new Date().toISOString(),routes:rows,interfaces,matches:library.routes.map(c=>({
    config_id:c.id,state:rows.some(r=>r.config_ids.includes(c.id))?'active':'inactive',route_keys:rows.filter(r=>r.config_ids.includes(c.id)).map(r=>r.key),reason:'演示匹配状态',
  }))};
}
export async function demoCall(command: string, args?: Record<string, unknown>): Promise<unknown> {
  await new Promise(resolve=>setTimeout(resolve,100));
  switch(command) {
    case 'get_snapshot': return structuredClone(snapshot());
    case 'get_library': return structuredClone(library);
    case 'get_history': return structuredClone(history);
    case 'get_settings': return {...settings};
    case 'save_setting': settings={...settings,[args!.key as string]:args!.value}; return;
    case 'save_library': library=structuredClone(args!.library as Library); return library;
    case 'read_hosts': return {...hosts};
    case 'save_hosts': hosts={...hosts,content:args!.content as string,fingerprint:crypto.randomUUID()}; return {...hosts};
    case 'export_yaml': return '演示模式：未写入任何文件';
    case 'import_yaml': throw new Error('演示模式不导入文件，请使用桌面程序验证 YAML 导入。');
    case 'preview_operation': {
      snapshot();
      const request=args!.request as PlanRequest;
      const targets = request.action==='apply' ? library.routes.filter(c=>request.config_ids?.includes(c.id)) : request.draft ? [request.draft] : [];
      pending={id:crypto.randomUUID(),created_at:new Date().toISOString(),warnings:['演示预览，不会修改真实系统'],library_fingerprint:'demo',items:[]};
      if(targets.length) pending.items=targets.map(target=>{
        const before=rows.find(r=>request.source_key?r.key===request.source_key:r.config_ids.includes(target.id))?.records??[];
        return {id:crypto.randomUUID(),label:target.name,action:before.length?'replace':'add',before,target,save_config:request.save_config??false,warnings:[]};
      });
      else pending.items=rows.filter(r=>request.action==='clear_managed'?r.ownership==='managed':request.route_keys?.includes(r.key)).map(r=>({
        id:crypto.randomUUID(),label:r.records[0].prefix,action:'remove',before:r.records,target:null,save_config:false,warnings:[],
      }));
      return structuredClone(pending);
    }
    case 'execute_operation': {
      if(!pending || pending.id!==args!.id) throw new Error('预览已失效');
      const result:OperationResult={id:pending.id,started_at:pending.created_at,finished_at:new Date().toISOString(),status:'success',items:[]};
      for(const item of pending.items) {
        rows=rows.filter(r=>!item.before.some(b=>key(b)===r.key));
        const target=item.target;
        const after:RouteRecord[]=[];
        if(target) {
          const added=row(record(target.prefix,target.gateway,'NetMgmt',target.metric??256,target.interface_id??ethernet),target.persistent);
          added.created_by_app=true;rows.push(added);after.push(...added.records);
          if(item.save_config) library.routes=[...library.routes.filter(c=>c.id!==target.id),target];
        }
        result.items.push({item_id:item.id,label:item.label,action:item.action,status:'success',message:'模拟操作完成，真实系统未修改',before:item.before,after,recovery:null});
      }
      history.unshift(result);pending=null;return result;
    }
    default: throw new Error('演示接口不支持：'+command);
  }
}
