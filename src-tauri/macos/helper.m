// Native, short-lived macOS adapter. No database, launchd job, or arbitrary command API.
#import <Foundation/Foundation.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <CommonCrypto/CommonDigest.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <net/route.h>
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <copyfile.h>
#include <libproc.h>
#include <unistd.h>
#include <mach-o/dyld.h>
#include <limits.h>
#include <errno.h>

static void fail(NSString *message) { @throw [NSException exceptionWithName:@"AdapterError" reason:message userInfo:nil]; }
static void check(BOOL ok, NSString *message) { if (!ok) fail(message); }
static NSString *text(id value) { check([value isKindOfClass:NSString.class], @"字符串参数无效"); return value; }
static NSString *digest(NSData *data) {
    unsigned char bytes[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, bytes);
    NSMutableString *result = [NSMutableString string]; for (int i=0;i<CC_SHA256_DIGEST_LENGTH;i++) [result appendFormat:@"%02x",bytes[i]]; return result;
}
static size_t aligned(size_t n) { return n ? (n+3)&~(size_t)3 : 4; }
static NSString *ip(struct sockaddr *sa, int family) {
    unsigned char bytes[16] = {0};
    size_t offset = family == AF_INET ? offsetof(struct sockaddr_in,sin_addr) : offsetof(struct sockaddr_in6,sin6_addr);
    size_t width = family == AF_INET ? 4 : 16;
    if (sa && sa->sa_len > offset) memcpy(bytes, (char *)sa + offset, MIN(width, sa->sa_len-offset));
    // Darwin stores an interface scope in link-local IPv6 sockaddr bytes, not the IP address.
    if (family == AF_INET6 && bytes[0] == 0xfe && (bytes[1]&0xc0) == 0x80) bytes[2]=bytes[3]=0;
    char output[INET6_ADDRSTRLEN]; check(inet_ntop(family,bytes,output,sizeof(output)) != NULL,@"地址格式错误");
    return @(output);
}
static int maskBits(struct sockaddr *mask, int family) {
    unsigned char bytes[16] = {0};
    size_t offset = family == AF_INET ? offsetof(struct sockaddr_in,sin_addr) : offsetof(struct sockaddr_in6,sin6_addr);
    int width = family == AF_INET ? 4 : 16;
    if(mask && mask->sa_len > offset) memcpy(bytes,(char *)mask+offset,MIN((size_t)width,mask->sa_len-offset));
    int bits=0; BOOL zero=NO;
    for(int i=0;i<width;i++) for(int b=7;b>=0;b--) { if(bytes[i]&(1<<b)) { check(!zero,@"系统返回非连续掩码"); bits++; } else zero=YES; }
    return bits;
}
static NSDictionary *prefix(NSString *value) {
    NSArray *parts=[value componentsSeparatedByString:@"/"];
    check(parts.count==2,@"IPv4 前缀无效");
    NSScanner *scanner=[NSScanner scannerWithString:parts[1]]; int bits;
    check([scanner scanInt:&bits] && scanner.isAtEnd && bits>=0 && bits<=32,@"IPv4 前缀长度无效");
    struct in_addr address; check(inet_pton(AF_INET,[parts[0] UTF8String],&address)==1,@"IPv4 地址无效");
    uint32_t mask=bits ? UINT32_MAX<<(32-bits) : 0;
    address.s_addr=htonl(ntohl(address.s_addr)&mask);
    char destination[INET_ADDRSTRLEN], maskText[INET_ADDRSTRLEN]; inet_ntop(AF_INET,&address,destination,sizeof(destination));
    struct in_addr netmask={.s_addr=htonl(mask)}; inet_ntop(AF_INET,&netmask,maskText,sizeof(maskText));
    return @{@"destination":@(destination),@"mask":@(maskText),@"bits":@(bits)};
}
static NSArray *identity(NSString *value) {
    NSArray *parts=[value componentsSeparatedByString:@":"];
    check(parts.count==3 && [parts[0] isEqual:@"macos"],@"此配置不是 macOS 接口，请重新绑定");
    NSString *device=parts[1], *service=parts[2];
    NSCharacterSet *allowed=[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
    check(device.length>0 && device.length<IFNAMSIZ && [device rangeOfCharacterFromSet:allowed.invertedSet].location==NSNotFound,@"接口名称无效");
    check([service isEqual:@"-"] || [[NSUUID alloc] initWithUUIDString:service]!=nil,@"网络服务标识无效");
    return parts;
}
static NSString *interfaceID(NSString *device, NSString *service) { return [NSString stringWithFormat:@"macos:%@:%@",device,service.lowercaseString ?: @"-"]; }

static NSArray *services(SCPreferencesRef prefs) {
    SCNetworkSetRef set=SCNetworkSetCopyCurrent(prefs); if(!set) return @[];
    CFArrayRef list=SCNetworkSetCopyServices(set); CFRelease(set);
    return list ? CFBridgingRelease(list) : @[];
}
static NSString *deviceFor(SCNetworkServiceRef service) {
    SCNetworkInterfaceRef interface=SCNetworkServiceGetInterface(service);
    while(interface) {
        CFStringRef device=SCNetworkInterfaceGetBSDName(interface);
        if(device) return (__bridge NSString *)device;
        interface=SCNetworkInterfaceGetInterface(interface);
    }
    return nil;
}
static NSMutableArray *activeRoutes(NSDictionary *deviceIDs) {
    int mib[]={CTL_NET,PF_ROUTE,0,AF_UNSPEC,NET_RT_DUMP2,0}; size_t length=0;
    NSMutableData *data=nil; BOOL read=NO;
    for(int attempt=0;attempt<3;attempt++) {
        check(sysctl(mib,6,NULL,&length,NULL,0)==0 && length<64*1024*1024,@"无法读取路由表大小");
        data=[NSMutableData dataWithLength:length];
        if(sysctl(mib,6,data.mutableBytes,&length,NULL,0)==0) { read=YES; break; }
        check(errno==ENOMEM,@"无法读取路由表");
    }
    check(read,@"路由表持续变化，请重试");
    NSMutableArray *records=[NSMutableArray array];
    char *cursor=data.mutableBytes, *end=cursor+length;
    while(cursor<end) {
        check(end-cursor >= (ptrdiff_t)sizeof(struct rt_msghdr2),@"路由消息被截断");
        struct rt_msghdr2 *header=(void *)cursor;
        check(header->rtm_msglen>=sizeof(*header) && cursor+header->rtm_msglen<=end && header->rtm_version==RTM_VERSION,@"路由消息格式无效");
        struct sockaddr *addresses[RTAX_MAX]={0}; char *next=(char *)(header+1), *limit=cursor+header->rtm_msglen;
        for(int i=0;i<RTAX_MAX;i++) if(header->rtm_addrs&(1<<i)) {
            check(next+2<=limit,@"路由地址被截断"); struct sockaddr *sa=(void *)next;
            check(next+aligned(sa->sa_len)<=limit,@"路由地址长度无效"); addresses[i]=sa; next+=aligned(sa->sa_len);
        }
        struct sockaddr *dst=addresses[RTAX_DST], *gw=addresses[RTAX_GATEWAY];
        if(dst && (dst->sa_family==AF_INET || dst->sa_family==AF_INET6) && !(header->rtm_flags&RTF_LLINFO)) {
            int family=dst->sa_family;
            check(dst->sa_len >= (family==AF_INET ? sizeof(struct sockaddr_in):sizeof(struct sockaddr_in6)),@"目标地址长度无效");
            char name[IFNAMSIZ]; check(if_indextoname(header->rtm_index,name)!=NULL,@"路由接口已变化，请刷新");
            NSString *device=@(name), *iid=deviceIDs[device] ?: interfaceID(device,nil);
            int bits=(header->rtm_flags&RTF_HOST) ? (family==AF_INET ? 32:128) : maskBits(addresses[RTAX_NETMASK],family);
            NSString *gateway=gw && gw->sa_family==family ? ip(gw,family) : (family==AF_INET ? @"0.0.0.0":@"::");
            NSString *protocol=(header->rtm_flags&(RTF_LOCAL|RTF_MULTICAST|RTF_BROADCAST)) ? @"Local" : ((header->rtm_flags&RTF_DYNAMIC) ? @"ICMP" : ((header->rtm_flags&RTF_STATIC) ? @"Static":@"Kernel"));
            [records addObject:@{@"family":family==AF_INET ? @"IPv4":@"IPv6",@"prefix":[NSString stringWithFormat:@"%@/%d",ip(dst,family),bits],@"gateway":gateway,
                @"interface_index":@(header->rtm_index),@"interface_id":iid,@"interface_alias":device,@"route_metric":@0,@"interface_metric":@0,@"protocol":protocol,@"rollback_safe":@NO,@"store":@"ActiveStore",
                @"native":@{@"scope":(header->rtm_flags&RTF_IFSCOPE)?@"scoped":@"unscoped",@"flags":@((uint32_t)header->rtm_flags)}}];
        }
        cursor+=header->rtm_msglen;
    }
    return records;
}
static NSDictionary *snapshot(void) {
    SCPreferencesRef prefs=SCPreferencesCreate(NULL,CFSTR("RouteManager"),NULL); check(prefs!=NULL,@"无法读取网络服务");
    @try {
        NSArray *list=services(prefs); NSMutableDictionary *byDevice=[NSMutableDictionary dictionary], *deviceIDs=[NSMutableDictionary dictionary];
        for(id object in list) {
            SCNetworkServiceRef service=(__bridge SCNetworkServiceRef)object; NSString *device=deviceFor(service); if(!device) continue;
            if(!byDevice[device]) byDevice[device]=[NSMutableArray array]; [byDevice[device] addObject:object];
        }
        for(NSString *device in byDevice) {
            NSArray *matches=byDevice[device];
            if(matches.count==1) deviceIDs[device]=interfaceID(device,(__bridge NSString *)SCNetworkServiceGetServiceID((__bridge SCNetworkServiceRef)matches[0]));
        }
        NSMutableDictionary *interfaces=[NSMutableDictionary dictionary]; struct ifaddrs *head=NULL;
        check(getifaddrs(&head)==0,@"无法读取接口");
        @try { for(struct ifaddrs *i=head;i;i=i->ifa_next) {
            NSString *device=@(i->ifa_name); NSMutableDictionary *item=interfaces[device];
            if(!item) { item=[@{@"guid":deviceIDs[device] ?: interfaceID(device,nil),@"index":@(if_nametoindex(i->ifa_name)),@"alias":device,@"status":(i->ifa_flags&IFF_UP)?@"Up":@"Down",@"addresses":[NSMutableArray array]} mutableCopy]; interfaces[device]=item; }
            if(i->ifa_addr && i->ifa_addr->sa_family==AF_INET) [item[@"addresses"] addObject:[NSString stringWithFormat:@"%@/%d",ip(i->ifa_addr,AF_INET),maskBits(i->ifa_netmask,AF_INET)]];
        } } @finally { freeifaddrs(head); }
        NSMutableArray *records=activeRoutes(deviceIDs);
        // Read only persisted Setup configuration, never DHCP State AdditionalRoutes.
        for(id object in list) {
            SCNetworkServiceRef service=(__bridge SCNetworkServiceRef)object; NSString *device=deviceFor(service); if(!device) continue;
            NSString *iid=interfaceID(device,(__bridge NSString *)SCNetworkServiceGetServiceID(service));
            SCNetworkProtocolRef protocol=SCNetworkServiceCopyProtocol(service,kSCNetworkProtocolTypeIPv4); if(!protocol) continue;
            NSDictionary *config=CFBridgingRelease(SCNetworkProtocolGetConfiguration(protocol) ? CFRetain(SCNetworkProtocolGetConfiguration(protocol)):NULL); CFRelease(protocol);
            id additional=config[@"AdditionalRoutes"]; if(!additional) continue; check([additional isKindOfClass:NSArray.class],@"持久路由配置格式无效");
            for(NSDictionary *route in additional) {
                struct sockaddr_in mask={.sin_len=sizeof(mask),.sin_family=AF_INET};
                check(inet_pton(AF_INET,[text(route[@"SubnetMask"]) UTF8String],&mask.sin_addr)==1,@"持久路由掩码无效");
                NSString *destination=text(route[@"DestinationAddress"]), *gateway=route[@"GatewayAddress"] ?: @"0.0.0.0";
                if([gateway isEqual:@""]) gateway=@"0.0.0.0";
                NSString *cidr=[NSString stringWithFormat:@"%@/%d",destination,maskBits((void *)&mask,AF_INET)]; NSDictionary *net=prefix(cidr);
                cidr=[NSString stringWithFormat:@"%@/%@",net[@"destination"],net[@"bits"]];
                NSArray *active=[records filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *r, NSDictionary *bindings) {
                    return [r[@"store"] isEqual:@"ActiveStore"] && [r[@"interface_id"] isEqual:iid] && [r[@"prefix"] isEqual:cidr] && [r[@"gateway"] isEqual:gateway];
                }]];
                NSString *scope=active.count==1 ? active[0][@"native"][@"scope"] : (active.count>1 ? @"ambiguous":@"unscoped");
                [records addObject:@{@"family":@"IPv4",@"prefix":cidr,@"gateway":gateway,@"interface_index":@(if_nametoindex(device.UTF8String)),@"interface_id":iid,@"interface_alias":device,@"route_metric":@0,@"interface_metric":@0,@"protocol":@"Static",@"rollback_safe":@NO,@"store":@"PersistentStore",@"native":@{@"scope":scope,@"flags":@0}}];
            }
        }
        return @{@"routes":records,@"interfaces":interfaces.allValues};
    } @finally { CFRelease(prefs); }
}
static BOOL same(NSDictionary *a, NSDictionary *b) {
    for(NSString *key in @[@"family",@"prefix",@"gateway",@"interface_id",@"interface_index",@"store"]) if(![a[key] isEqual:b[key]]) return NO;
    return [a[@"store"] isEqual:@"PersistentStore"] || [a[@"native"][@"scope"] isEqual:b[@"native"][@"scope"]];
}
static NSArray *mutateAdditionalRoutes(NSArray *original, NSDictionary *target, BOOL adding) {
                NSMutableArray *routes=[original mutableCopy]; NSDictionary *net=prefix(text(target[@"prefix"])); NSString *gw=text(target[@"gateway"]);
                NSDictionary *entry=@{@"DestinationAddress":net[@"destination"],@"SubnetMask":net[@"mask"],@"GatewayAddress":[gw isEqual:@"0.0.0.0"] ? @"":gw};
                NSIndexSet *matches=[routes indexesOfObjectsPassingTest:^BOOL(NSDictionary *r, NSUInteger index, BOOL *stop) {
                    NSString *gateway=r[@"GatewayAddress"] ?: @""; if([gateway isEqual:@"0.0.0.0"]) gateway=@"";
                    return [r[@"DestinationAddress"] isEqual:entry[@"DestinationAddress"]] && [r[@"SubnetMask"] isEqual:entry[@"SubnetMask"]] && [gateway isEqual:entry[@"GatewayAddress"]];
                }];
                check(matches.count<=1,@"原生持久配置存在重复记录，无法精确修改");
                if(adding) { check(matches.count==0,@"持久目标已有记录，请重新预览"); [routes addObject:entry]; }
                else {
                    check(matches.count==1,@"持久记录已变化，请重新预览");
                    NSDictionary *originalEntry=routes[matches.firstIndex];
                    for(NSString *key in originalEntry) check([@[@"DestinationAddress",@"SubnetMask",@"GatewayAddress"] containsObject:key],@"持久记录包含特殊属性，不能安全重建或移除");
                    [routes removeObjectsAtIndexes:matches];
                }
    return routes;
}
static void persistent(NSDictionary *target, BOOL adding) {
    NSArray *iid=identity(text(target[@"interface_id"])); check(![iid[2] isEqual:@"-"],@"此接口不支持原生持久化");
    SCPreferencesRef prefs=SCPreferencesCreate(NULL,CFSTR("RouteManager"),NULL); check(prefs!=NULL,@"无法打开网络配置"); BOOL locked=NO;
    @try {
        check(SCPreferencesLock(prefs,FALSE),@"网络配置正在被其他程序修改"); locked=YES; SCPreferencesSynchronize(prefs);
        SCNetworkServiceRef found=NULL;
        for(id object in services(prefs)) { SCNetworkServiceRef service=(__bridge SCNetworkServiceRef)object;
            if([(__bridge NSString *)SCNetworkServiceGetServiceID(service) caseInsensitiveCompare:iid[2]]==NSOrderedSame && [deviceFor(service) isEqual:iid[1]]) { found=(SCNetworkServiceRef)CFRetain(service); break; }
        }
        // Retain the service independently of the temporary enumeration array.
        check(found!=NULL,@"网络服务已变化，请重新预览");
        @try {
            if(adding) check(SCNetworkServiceGetEnabled(found),@"网络服务已停用，无法应用持久路由");
            SCNetworkProtocolRef protocol=SCNetworkServiceCopyProtocol(found,kSCNetworkProtocolTypeIPv4); check(protocol!=NULL,@"网络服务没有 IPv4 配置");
            @try {
                NSDictionary *current=(__bridge NSDictionary *)SCNetworkProtocolGetConfiguration(protocol); check(current!=nil,@"IPv4 配置不存在");
                NSMutableDictionary *updated=[current mutableCopy]; id original=current[@"AdditionalRoutes"] ?: @[]; check([original isKindOfClass:NSArray.class],@"持久路由配置格式无效");
                NSArray *routes=mutateAdditionalRoutes(original,target,adding);
                updated[@"AdditionalRoutes"]=routes;
                check(SCNetworkProtocolSetConfiguration(protocol,(__bridge CFDictionaryRef)updated),@"无法更新持久配置");
                check(SCPreferencesCommitChanges(prefs),@"持久配置提交失败");
                check(SCPreferencesApplyChanges(prefs),@"持久配置已保存，但通知系统应用失败，请刷新核对");
            } @finally { CFRelease(protocol); }
        } @finally { CFRelease(found); }
    } @finally { if(locked) SCPreferencesUnlock(prefs); CFRelease(prefs); }
}
static void routeWrite(NSDictionary *target, BOOL adding) {
    NSArray *iid=identity(text(target[@"interface_id"])); unsigned index=if_nametoindex([iid[1] UTF8String]); check(index!=0,@"接口已消失");
    NSDictionary *net=prefix(text(target[@"prefix"])); NSString *gateway=text(target[@"gateway"]);
    struct { struct rt_msghdr header; unsigned char addresses[512]; } message={0};
    struct sockaddr_in dst={.sin_len=sizeof(dst),.sin_family=AF_INET}, gw={.sin_len=sizeof(gw),.sin_family=AF_INET}, mask={.sin_len=sizeof(mask),.sin_family=AF_INET};
    check(inet_pton(AF_INET,[net[@"destination"] UTF8String],&dst.sin_addr)==1 && inet_pton(AF_INET,gateway.UTF8String,&gw.sin_addr)==1 && inet_pton(AF_INET,[net[@"mask"] UTF8String],&mask.sin_addr)==1,@"路由地址无效");
    BOOL direct=gw.sin_addr.s_addr==0; struct sockaddr_dl link={.sdl_len=sizeof(link),.sdl_family=AF_LINK,.sdl_index=index};
    message.header.rtm_type=adding ? RTM_ADD:RTM_DELETE; message.header.rtm_version=RTM_VERSION;
    message.header.rtm_flags=RTF_UP|RTF_STATIC|(direct ? 0:RTF_GATEWAY);
    if([net[@"bits"] intValue]==32) message.header.rtm_flags|=RTF_HOST;
    if([target[@"scope"] isEqual:@"scoped"] || [target[@"native"][@"scope"] isEqual:@"scoped"]) message.header.rtm_flags|=RTF_IFSCOPE;
    message.header.rtm_index=index; message.header.rtm_pid=getpid(); message.header.rtm_seq=arc4random()&INT_MAX;
    message.header.rtm_addrs=RTA_DST|RTA_GATEWAY|RTA_NETMASK|RTA_IFP;
    char *cursor=(void *)message.addresses;
    struct sockaddr *addresses[]={(void *)&dst,direct ? (void *)&link:(void *)&gw,(void *)&mask,(void *)&link};
    for(int i=0;i<4;i++) { memcpy(cursor,addresses[i],addresses[i]->sa_len); cursor+=aligned(addresses[i]->sa_len); }
    message.header.rtm_msglen=cursor-(char *)&message;
    int fd=socket(PF_ROUTE,SOCK_RAW,0); check(fd>=0,@"无法打开系统路由接口");
    @try {
        struct timeval timeout={.tv_sec=5}; setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
        check(write(fd,&message,message.header.rtm_msglen)==message.header.rtm_msglen,@"路由写入失败，请刷新核对");
        unsigned char buffer[8192]; BOOL acknowledged=NO;
        for(int i=0;i<512;i++) { ssize_t length=read(fd,buffer,sizeof(buffer)); check(length>=(ssize_t)sizeof(struct rt_msghdr),@"路由响应超时，结果未知"); struct rt_msghdr *reply=(void *)buffer;
            if(reply->rtm_pid==getpid() && reply->rtm_seq==message.header.rtm_seq) { check(reply->rtm_errno==0,[NSString stringWithFormat:@"系统拒绝路由修改：%s",strerror(reply->rtm_errno)]); acknowledged=YES; break; }
        }
        check(acknowledged,@"未收到路由确认，结果未知");
    } @finally { close(fd); }
}
static void validateTarget(NSDictionary *target) {
    identity(text(target[@"interface_id"])); prefix(text(target[@"prefix"])); struct in_addr gateway;
    check(inet_pton(AF_INET,[text(target[@"gateway"]) UTF8String],&gateway)==1,@"IPv4 网关无效");
    check(!target[@"metric"] || target[@"metric"]==NSNull.null,@"macOS 不支持 Windows metric");
    id scope=target[@"scope"];
    check(!scope || scope==NSNull.null || ([@[@"scoped",@"unscoped"] containsObject:scope] && ![target[@"persistent"] boolValue]),@"路由作用域无效");
    NSArray *matches=[snapshot()[@"interfaces"] filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *i, NSDictionary *bindings) { return [i[@"guid"] isEqual:target[@"interface_id"]] && [i[@"status"] isEqual:@"Up"]; }]];
    check(matches.count==1,@"接口已变化、不可用或存在歧义");
}
static void replaceHosts(NSDictionary *request) {
    NSString *expected=text(request[@"fingerprint"]); NSData *bytes=[[NSData alloc] initWithBase64EncodedString:text(request[@"bytes"]) options:0]; check(bytes && bytes.length<=2*1024*1024,@"hosts 内容无效");
    const char *path="/private/etc/hosts"; int original=open(path,O_RDONLY|O_NOFOLLOW); check(original>=0,@"无法打开 hosts");
    char temporary[]="/private/etc/.route-manager-hosts-XXXXXX"; int output=-1;
    @try {
        struct stat before; check(fstat(original,&before)==0 && S_ISREG(before.st_mode),@"hosts 不是普通文件");
        NSData *current=[NSData dataWithContentsOfFile:@(path)]; check(current && [digest(current) isEqual:expected],@"hosts 已被其他程序修改");
        output=mkstemp(temporary); check(output>=0,@"无法创建 hosts 临时文件");
        check(fcopyfile(original,output,NULL,COPYFILE_METADATA)==0,@"无法保留 hosts 元数据");
        check(fchown(output,before.st_uid,before.st_gid)==0 && fchmod(output,before.st_mode&07777)==0,@"无法保留 hosts 权限");
        size_t offset=0; while(offset<bytes.length) { ssize_t n=write(output,(const char *)bytes.bytes+offset,bytes.length-offset); check(n>0,@"hosts 写入失败"); offset+=n; }
        check(fsync(output)==0,@"hosts 同步失败");
        struct stat after; current=[NSData dataWithContentsOfFile:@(path)];
        check(lstat(path,&after)==0 && after.st_ino==before.st_ino && after.st_dev==before.st_dev && current && [digest(current) isEqual:expected],@"保存期间 hosts 已变化，未覆盖");
        check(rename(temporary,path)==0,@"hosts 原子替换失败");
        int directory=open("/private/etc",O_RDONLY); if(directory>=0) { fsync(directory); close(directory); }
    } @finally { close(original); if(output>=0) { close(output); unlink(temporary); } }
}
static id dispatch(NSDictionary *request) {
    NSString *action=text(request[@"action"]);
    if([action isEqual:@"hosts"]) { replaceHosts(request); return @{}; }
    if([action isEqual:@"add"]) {
        NSDictionary *target=request[@"target"]; check([target isKindOfClass:NSDictionary.class],@"目标无效"); validateTarget(target);
        for(NSDictionary *record in snapshot()[@"routes"]) {
            BOOL relevantScope=[target[@"persistent"] boolValue] || [record[@"store"] isEqual:@"PersistentStore"] || [record[@"native"][@"scope"] isEqual:([target[@"scope"] isKindOfClass:NSString.class] ? target[@"scope"] : @"unscoped")];
            check(!(relevantScope && [record[@"prefix"] isEqual:target[@"prefix"]] && [record[@"gateway"] isEqual:target[@"gateway"]] && [record[@"interface_id"] isEqual:target[@"interface_id"]]),@"新目标已有路由，未覆盖");
        }
        if([target[@"persistent"] boolValue]) persistent(target,YES); else routeWrite(target,YES);
        return @{};
    }
    if([action isEqual:@"remove"]) {
        NSArray *records=request[@"records"]; check([records isKindOfClass:NSArray.class] && records.count>0 && records.count<4096,@"删除记录无效");
        NSArray *current=snapshot()[@"routes"];
        for(NSDictionary *expected in records) {
            check([expected[@"family"] isEqual:@"IPv4"],@"IPv6 只读"); identity(text(expected[@"interface_id"]));
            NSArray *matches=[current filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *r, NSDictionary *bindings) { return same(r,expected); }]];
            check(matches.count==1 && [matches[0][@"native"] isEqual:expected[@"native"]],@"删除前记录已变化，请重新预览");
        }
        for(NSDictionary *record in records) if([record[@"store"] isEqual:@"PersistentStore"]) persistent(record,NO);
        for(NSDictionary *record in records) if([record[@"store"] isEqual:@"ActiveStore"]) {
            NSArray *matches=[snapshot()[@"routes"] filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *r, NSDictionary *bindings) { return same(r,record); }]];
            if(matches.count) { check(matches.count==1 && [matches[0][@"native"] isEqual:record[@"native"]],@"删除期间路由发生变化"); routeWrite(record,NO); }
        }
        return @{};
    }
    fail(@"不支持的助手操作"); return nil;
}
static NSDictionary *answer(NSDictionary *request) {
    @try { check([request isKindOfClass:NSDictionary.class],@"请求格式无效"); return @{@"ok":@YES,@"data":dispatch(request)}; }
    @catch(NSException *e) { return @{@"ok":@NO,@"error":e.reason ?: @"原生操作失败"}; }
}
static void sendJSON(int fd, id object) {
    NSMutableData *bytes=[[NSJSONSerialization dataWithJSONObject:object options:0 error:nil] mutableCopy]; [bytes appendBytes:"\n" length:1];
    size_t offset=0; while(offset<bytes.length) { ssize_t n=write(fd,(char *)bytes.bytes+offset,bytes.length-offset); check(n>0,@"调用方连接已断开"); offset+=n; }
}
static void serve(NSString *path, pid_t expectedPID) {
    check(geteuid()==0,@"助手未获得管理员授权"); struct sockaddr_un address={.sun_family=AF_UNIX};
    check(path.length>0 && strlen(path.fileSystemRepresentation)<sizeof(address.sun_path),@"连接路径无效"); strlcpy(address.sun_path,path.fileSystemRepresentation,sizeof(address.sun_path));
    int fd=socket(AF_UNIX,SOCK_STREAM,0); check(fd>=0,@"无法创建助手连接");
    @try {
        check(connect(fd,(void *)&address,sizeof(address))==0,@"调用方已退出");
        uid_t uid; gid_t gid; check(getpeereid(fd,&uid,&gid)==0 && uid!=0,@"助手仅接受用户界面连接");
        pid_t pid=0; socklen_t size=sizeof(pid); check(getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,&pid,&size)==0,@"无法核验调用进程");
        check(pid==expectedPID,@"连接不是发起授权的进程");
        char executable[PROC_PIDPATHINFO_MAXSIZE]; check(proc_pidpath(pid,executable,sizeof(executable))>0,@"调用进程已退出");
        uint32_t ownLength=PROC_PIDPATHINFO_MAXSIZE; char ownBuffer[PROC_PIDPATHINFO_MAXSIZE];
        check(_NSGetExecutablePath(ownBuffer,&ownLength)==0,@"无法确定助手路径");
        NSString *own=[@(ownBuffer) stringByResolvingSymlinksInPath];
        NSString *parent=[@(executable) stringByResolvingSymlinksInPath];
        NSString *expected=[[[own stringByDeletingLastPathComponent] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"MacOS/RouteManager"];
#ifdef ROUTE_MANAGER_DEVELOPMENT
        if(![own containsString:@".app/Contents/"]) expected=[[own stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"RouteManager"];
#endif
        check([parent isEqual:expected],@"调用方不是同一应用包的主程序");
        struct timeval timeout={.tv_sec=45}; setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout)); setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
        int noSignal=1; setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&noSignal,sizeof(noSignal));
        NSMutableData *line=[NSMutableData data]; char buffer[8192];
        while(YES) { ssize_t n=read(fd,buffer,sizeof(buffer)); if(n==0) break; check(n>0,@"调用方连接超时");
            for(ssize_t i=0;i<n;i++) { if(buffer[i]=='\n') { @autoreleasepool { id request=[NSJSONSerialization JSONObjectWithData:line options:0 error:nil]; alarm(45); sendJSON(fd,answer(request)); alarm(0); [line setLength:0]; } }
                else { check(line.length<8*1024*1024,@"请求过大"); [line appendBytes:&buffer[i] length:1]; }
            }
        }
    } @finally { close(fd); }
}
int main(int argc, const char **argv) {
    @autoreleasepool { @try {
        if(argc==2 && strcmp(argv[1],"snapshot")==0) { sendJSON(STDOUT_FILENO,@{@"ok":@YES,@"data":snapshot()}); return 0; }
        if(argc==4 && strcmp(argv[1],"serve")==0) {
            char *end=NULL; long pid=strtol(argv[3],&end,10);
            check(end && *end=='\0' && pid>0 && pid<=INT_MAX,@"调用进程标识无效");
            serve(@(argv[2]),(pid_t)pid); return 0;
        }
        if(argc==2 && strcmp(argv[1],"self-test")==0) {
            check([prefix(@"203.0.113.17/24")[@"destination"] isEqual:@"203.0.113.0"],@"prefix test");
            check([identity(@"macos:en0:11111111-1111-4111-8111-111111111111")[1] isEqual:@"en0"],@"identity test");
            check([digest([NSData data]) isEqual:@"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],@"digest test");
            BOOL rejected=NO; @try { prefix(@"203.0.113.0/33"); } @catch(NSException *e) { rejected=YES; } check(rejected,@"invalid prefix test");
            NSDictionary *a=@{@"DestinationAddress":@"203.0.113.0",@"SubnetMask":@"255.255.255.0",@"GatewayAddress":@"192.0.2.1"};
            NSDictionary *b=@{@"DestinationAddress":@"198.51.100.0",@"SubnetMask":@"255.255.255.0",@"GatewayAddress":@"192.0.2.2",@"UnknownAttribute":@"preserved"};
            NSDictionary *target=@{@"prefix":@"203.0.113.0/24",@"gateway":@"192.0.2.1"};
            check([mutateAdditionalRoutes(@[a,b],target,NO) isEqual:@[b]],@"unrelated persistent entry preserved");
            check([mutateAdditionalRoutes(@[b],target,YES) isEqual:@[b,a]],@"native persistence append");
            rejected=NO; @try { mutateAdditionalRoutes(@[a,a],target,NO); } @catch(NSException *e) { rejected=YES; } check(rejected,@"duplicate persistent route rejected");
            rejected=NO; @try { mutateAdditionalRoutes(@[a],target,YES); } @catch(NSException *e) { rejected=YES; } check(rejected,@"existing target rejected");
            rejected=NO; @try { mutateAdditionalRoutes(@[b],target,NO); } @catch(NSException *e) { rejected=YES; } check(rejected,@"missing target rejected");
            NSDictionary *physical=@{@"family":@"IPv4",@"prefix":@"203.0.113.0/24",@"gateway":@"192.0.2.1",@"interface_id":@"macos:en0:11111111-1111-4111-8111-111111111111",@"interface_index":@7,@"store":@"PersistentStore",@"native":@{@"scope":@"scoped",@"flags":@0}};
            NSMutableDictionary *residual=[physical mutableCopy]; residual[@"native"]=@{@"scope":@"unscoped",@"flags":@0}; check(same(physical,residual),@"persistent scope association is not physical identity");
            check([answer(@{@"action":@"unknown"})[@"ok"] isEqual:@NO],@"unknown helper command rejected");
            puts("Native pure contract tests passed"); return 0;
        }
        fail(@"无效助手入口");
    } @catch(NSException *e) { sendJSON(STDOUT_FILENO,@{@"ok":@NO,@"error":e.reason ?: @"原生接口失败"}); return 1; } }
}
