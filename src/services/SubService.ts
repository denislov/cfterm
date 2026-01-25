import { WorkerContext } from '../core/Context';
import { NodeInfo } from '../types';
import { Utils } from '../Utils';

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
			'X-ECH-Config-Length': '0',
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
		const links: string[] = [];
		nodes.forEach((node) => {
			links.push(`${node.type}://${node.user}@${node.ip}:${node.port}?${node.wsParams?.toString()}#${node.name}`);
		});
		return links.join('\n');
	}

	async _collectNodes(): Promise<NodeInfo[]> {
		const kvConfig = this.ctx.kvConfig;
		const finalLinks: NodeInfo[] = [];
		const workerDomain = this.ctx.url.hostname;

		// 如果启用了ECH，使用自定义值
		let echConfig: string | null = null;
		if (kvConfig?.ech) {
			const dnsServer = kvConfig.customDNS || 'https://ds.asenser.cn/v1/chat/completions';
			const echDomain = kvConfig.customECHDomain || 'cloudflare-ech.com';
			echConfig = `${echDomain}+${dnsServer}`;
		}
        const proto = atob('dmxlc3M=');
		const addNodesFromList = (list: NodeInfo[]) => {
			if (kvConfig?.ev) {
				finalLinks.push(...this.generateLinksFromSource(list, this.ctx.uuid, workerDomain, echConfig));
			}
		};
		const nativeList: NodeInfo[] = [{ ip: workerDomain, name: '原生地址', port: 443, type: proto }];
		addNodesFromList(nativeList);

		this.ctx.kvDomain?.builtin.forEach((item) => {
            if (this.ctx.region != 'CUSTOM') {
                const bestBackupIP = Utils.getBestBackupIP(this.ctx.region, this.ctx);
                item.backupArg = bestBackupIP?.domain ? `&${bestBackupIP?.domain}`:undefined;
            }
			const cfList: NodeInfo[] = [{ ip: item.domain, name: item.name!, port: 443, type: proto, pathArgs: item.backupArg }];
			addNodesFromList(cfList);
		});
		this.ctx.kvDomain?.custom.forEach((item) => {
			const cfList: NodeInfo[] = [{ ip: item.domain, name: item.name!, port: 443, type: proto }];
			addNodesFromList(cfList);
		});

		if (finalLinks.length === 0) {
			const errorRemark = '所有节点获取失败';
			const proto = atob('dmxlc3M=');
			finalLinks.push({
				type: proto,
				user: 'user',
				ip: 'ip',
				port: 0,
				name: errorRemark,
			});
		}
		return finalLinks; // 返回节点数组
	}
	generateLinksFromSource(
		list: NodeInfo[],
		user: string,
		workerDomain: string,
		echConfig: string | null = null,
		addonPath: string | null = null,
	) {
		const defaultHttpsPorts = [443, 2053, 2083, 2087, 2096, 8443];

		const links: NodeInfo[] = [];
		let wsPath = '/?ed=2048';
		if (addonPath) {
			wsPath += `&${addonPath}`;
		}
		list.forEach((item) => {
			let nodeNameBase = item.name.replace(/\s/g, '_');
			if (defaultHttpsPorts.includes(item.port)) {
				const wsNodeName = `${nodeNameBase}-WS-TLS`;
				const wsParams = new URLSearchParams({
					encryption: 'none',
					security: 'tls',
					sni: workerDomain,
					fp: this.ctx.kvConfig?.ech ? 'chrome' : 'randomized',
					type: 'ws',
					host: workerDomain,
					path: wsPath,
				});

				// 如果启用了ECH，添加ech参数（ECH需要伪装成Chrome浏览器）
				if (echConfig) {
					wsParams.set('alpn', 'h3,h2,http/1.1');
					wsParams.set('ech', `${echConfig}`);
				}
				links.push({
					type: item.type,
					user: user,
					ip: item.ip,
					port: item.port,
					wsParams: wsParams,
					name: wsNodeName,
				});
			} else {
				const wsNodeName = `${nodeNameBase}-WS`;
				const wsParams = new URLSearchParams({
					encryption: 'none',
					security: 'none',
					type: 'ws',
					host: workerDomain,
					path: wsPath,
				});
				links.push({
					type: item.type,
					user: user,
					ip: item.ip,
					port: item.port,
					wsParams: wsParams,
					name: wsNodeName,
				});
			}
		});
		return links;
	}
	_toClashConfig(nodes: NodeInfo[]) {
		// 生成 YAML
		let text = `proxies:`;
		nodes.forEach((node) => {
			text += `
  - { name: ${node.name}, server: ${node.ip}, port: ${node.port}, client-fingerprint: chrome, type: ${node.type}, UUID: ${node.user}, tls: true, sni: ${node.wsParams?.get('host')}, network: ${node.wsParams?.get('type')}, ws-opts: { path: "${node.wsParams?.get('path')}", headers: { Host: ${node.wsParams?.get('host')} } } `;
			if (this.ctx.kvConfig.ech) {
				text += `, ech-opts: {enable: true, query-server-name: ${this.ctx.kvConfig.customECHDomain || 'cloudflare-ech.com'} }`;
			} 
			text += '}';
		});
		return text;
	}
}
