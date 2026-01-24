import { WorkerContext } from "../core/Context";
import { NodeInfo } from "../types";
import { Utils } from "../Utils";

export class SubService {
    ctx: WorkerContext;
    // 定义节点类型

    constructor(ctx: WorkerContext) {
        this.ctx = ctx;
    }

    async handle() {
        // 1. 收集所有可用节点 (优选 IP + 备份 IP + 自定义 IP)
        const nodes = await this._collectNodes();

        // 2. 根据查询参数 target 生成不同格式 (Clash, Base64, etc.)
        const target = this.ctx.url.searchParams.get('target') || 'base64';

        let subscriptionContent = '';
        let contentType = 'text/plain; charset=utf-8';
        if (target.toLowerCase().includes('clash')) {
            subscriptionContent = this._toClashConfig(nodes);
            contentType = 'text/yaml; charset=utf-8';
        } else {
            subscriptionContent = this._toBase64(nodes);
        }

        const responseHeaders = {
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'X-ECH-Status': 'DISABLED',
            'X-ECH-Config-Length': '0'
        };

        // 添加ECH状态到响应头
        if (this.ctx.kvConfig?.ech) {
            responseHeaders['X-ECH-Status'] = 'ENABLED';
            if (this.ctx.kvConfig.echConfig) {
                responseHeaders['X-ECH-Config-Length'] = String(this.ctx.kvConfig.echConfig.length);
            }
        }

        return new Response(subscriptionContent, {
            headers: responseHeaders,
        });
    }
    private _toBase64(nodes: NodeInfo[]): string {
        const links:string[] = [];
        nodes.forEach((node)=>{
            links.push(`${node.type}://${node.user}@${node.ip}:${node.port}?${node.wsParams?.toString()}#${node.name}`);
        })
        return links.join('\n');
    }


    async _collectNodes(): Promise<NodeInfo[]> {
        const kvConfig = this.ctx.kvConfig;
        const finalLinks:NodeInfo[] = [];
        const workerDomain = this.ctx.url.hostname;

        // 如果启用了ECH，使用自定义值
        let echConfig: string | null = null;
        if (kvConfig?.ech) {
            const dnsServer = kvConfig.customDNS || 'https://dns.jhb.ovh/joeyblog';
            const echDomain = kvConfig.customECHDomain || 'cloudflare-ech.com';
            echConfig = `${echDomain}+${dnsServer}`;
        }

        const addNodesFromList = (list: NodeInfo[]) => {
            if (kvConfig?.ev) {
                finalLinks.push(...this.generateLinksFromSource(list, this.ctx.uuid, workerDomain, echConfig));
            }
        }
        const nativeList: NodeInfo[] = [{ ip: workerDomain, name: '原生地址', port: 443, type: "vless" }];
        addNodesFromList(nativeList);

        if (this.ctx.region != 'CUSTOM') {
            const bestBackupIP = Utils.getBestBackupIP(this.ctx.region, this.ctx);
            if (bestBackupIP) {
                const backupList: NodeInfo[] = [{ ip: bestBackupIP.domain, name: 'ProxyIP-' + this.ctx.region, port: 443, type: "vless" }];
                addNodesFromList(backupList);
            }
        }
        this.ctx.kvDomain?.builtin.forEach(item => {
            const cfList: NodeInfo[] = [{ ip: item.domain, name: 'CFYX-' + item.name, port: 443, type: "vless" }];
            addNodesFromList(cfList);
        });
        this.ctx.kvDomain?.custom.forEach(item => {
            const cfList: NodeInfo[] = [{ ip: item.domain, name: 'CFYX-' + item.name, port: 443, type: "vless" }];
            addNodesFromList(cfList);
        });

        if (finalLinks.length === 0) {
            const errorRemark = "所有节点获取失败";
            const proto = atob('dmxlc3M=');
            finalLinks.push({
                        type: proto,
                        user: "user",
                        ip: "ip",
                        port: 0,
                        name: errorRemark,
                    });
        }
        return finalLinks; // 返回节点数组
    }
    generateLinksFromSource(list: NodeInfo[], user: string, workerDomain: string, echConfig: string | null = null) {

        // CF_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
        const defaultHttpsPorts = [443];

        const links: NodeInfo[] = [];
        const wsPath = '/?ed=2048';
        const proto = atob('dmxlc3M=');

        list.forEach(item => {
            let nodeNameBase = item.name.replace(/\s/g, '_');

            let portsToGenerate: { port: number, tls: boolean }[] = [];


            defaultHttpsPorts.forEach(port => {
                portsToGenerate.push({ port: port, tls: true });
            });

            portsToGenerate.forEach(({ port, tls }) => {
                if (tls) {
                    const wsNodeName = `${nodeNameBase}-${port}-WS-TLS`;
                    const wsParams = new URLSearchParams({
                        encryption: 'none',
                        security: 'tls',
                        sni: workerDomain,
                        fp: this.ctx.kvConfig?.ech ? 'chrome' : 'randomized',
                        type: 'ws',
                        host: workerDomain,
                        path: wsPath
                    });

                    // 如果启用了ECH，添加ech参数（ECH需要伪装成Chrome浏览器）
                    if (this.ctx.kvConfig?.ech) {
                        const dnsServer = this.ctx.kvConfig.customDNS || 'https://ds.asenser.cn/v1/chat/completions';
                        const echDomain = this.ctx.kvConfig.customECHDomain || 'cloudflare-ech.com';
                        wsParams.set('alpn', 'h3,h2,http/1.1');
                        wsParams.set('ech', `${echDomain}+${dnsServer}`);
                    }
                    links.push({
                        type: proto,
                        user: user,
                        ip: item.ip,
                        port: port,
                        wsParams: wsParams,
                        name:wsNodeName,
                    })
                } else {

                    const wsNodeName = `${nodeNameBase}-${port}-WS`;
                    const wsParams = new URLSearchParams({
                        encryption: 'none',
                        security: 'none',
                        type: 'ws',
                        host: workerDomain,
                        path: wsPath
                    });
                    links.push({
                        type: proto,
                        user: user,
                        ip: item.ip,
                        port: port,
                        wsParams: wsParams,
                        name:wsNodeName,
                    })
                }
            });
        });
        return links;
    }
    _toClashConfig(nodes: NodeInfo[]) {
        // 生成 YAML
        let text = `port: 7890
socks-port: 7891
allow-lan: true
mode: rule
log-level: warning
global-client-fingerprint: firefox
external-controller: :9090
dns:
  enable: true
  prefer-h3: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  # fake-ip-filter start
  fake-ip-filter:
    - +.m2m
    - injections.adguard.org
    - local.adguard.org
    - +.bogon
    - home.arpa
    - 127.0.0.1.sslip.io
    - 127.atlas.skk.moe
    - dns.msftncsi.com
    - "*.srv.nintendo.net"
    - "*.stun.playstation.net"
    - xbox.*.microsoft.com
    - "*.xboxlive.com"
    - "*.turn.twilio.com"
    - "*.stun.twilio.com"
    - stun.syncthing.net
    - stun.*
    - 127.*.*.*.sslip.io
    - 127-*-*-*.sslip.io
    - "*.127.*.*.*.sslip.io"
    - "*-127-*-*-*.sslip.io"
    - 127.*.*.*.nip.io
    - 127-*-*-*.nip.io
    - "*.127.*.*.*.nip.io"
    - "*-127-*-*-*.nip.io"
    - "geosite:connectivity-check"
    - "geosite:private"
  # fake-ip-filter end
rules:
  - DOMAIN-SUFFIX,services.googleapis.cn,节点选择
  - DOMAIN-SUFFIX,xn--ngstr-ira8j.com,节点选择
  - DOMAIN-SUFFIX,services.googleapis.com,节点选择
  - GEOSITE,microsoft@cn,DIRECT
  - GEOSITE,apple,DIRECT
  - GEOSITE,category-games@cn,DIRECT
  - GEOSITE,cn,DIRECT
  - GEOIP,cn,DIRECT
  - GEOSITE,private,DIRECT
  - GEOIP,private,DIRECT
  - MATCH,节点选择
proxy-groups:
  - { name: 节点选择, type: select, include-all: true, exclude-type: direct, proxies: [ 自动优选 ] }
  - { name: 自动优选, type: url-test, include-all: true, exclude-type: direct }
proxies:`;
            nodes.forEach((node)=> {
                text += `
  - { name: ${node.name}, server: ${node.ip}, port: ${node.port}, client-fingerprint: firefox, type: ${node.type}, UUID: ${node.user}, tls: true, servername: ${node.wsParams?.get("host")}, network: ${node.wsParams?.get("type")}, ws-opts: { path: "${node.wsParams?.get('path')}", headers: { Host: ${node.wsParams?.get('host')} } } `;
                if (this.ctx.kvConfig.ech){
                    text+=`ech-opts: {enable: true, query-server-name: ${this.ctx.kvConfig.customECHDomain || 'cloudflare-ech.com'}`
                } else {
                    text +='}'
                }
            })
        return text;
    }
}