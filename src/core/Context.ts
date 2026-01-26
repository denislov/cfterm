import { DomainRecord, DomainStorage, KVConfig } from '../types';
import { CF_BEST_DOMAINS, CONSTANTS } from './Constants';

export class WorkerContext {
	readonly request: Request;
	readonly env: Env;
	readonly executionCtx: ExecutionContext;
	readonly url: URL;
	readonly uuid: string;
	readonly kv: KVNamespace | null;
	featureFlags: Record<string, boolean>;
	isAuth: boolean = false;
	region: string;
	kvConfig: KVConfig;
	kvDomain: DomainStorage;
	state: Map<string, any>;
	echConfig?:string;

	constructor(request: Request, env: Env, executionCtx: ExecutionContext) {
		this.request = request;
		this.env = env;
		this.executionCtx = executionCtx;
		this.url = new URL(request.url);
		this.uuid = env.u;
		this.kv = env.C || null;
		this.region = this._detectRegion();
		this.featureFlags = {};
		this.state = new Map<string, any>();
		// 初始化默认 kvConfig
		this.kvConfig = { ...CONSTANTS.KV_CONFIG_DEFAULTS };
		this.kvDomain = {
			builtin: CF_BEST_DOMAINS.map((item) => ({ domain: item.domain, name: item.name, enabled: true, type: 'builtin' }) as DomainRecord),
			custom: [],
		};
	}

	async loadKVConfig() {
		if (!this.kv) {
			return;
		}

		try {
			const configData = await this.kv.get('c');
			if (!configData) {
				this.kv.put(CONSTANTS.KV_KEY_CONFIG, JSON.stringify(CONSTANTS.KV_CONFIG_DEFAULTS));
			} else {
				const configJson = JSON.parse(configData);
				// 遍历配置项进行赋值
				Object.entries(CONSTANTS.KV_CONFIG_DEFAULTS).forEach(([key, defaultValue]) => {
					this.kvConfig[key] = this._parseVarType(configJson[key], defaultValue);
				});
			}
		} catch (error) {
			// 使用默认配置
			console.warn('[KV] load config failed, using defaults', error);
		}
		try {
			const kvData = await this.kv!.get(CONSTANTS.KV_KEY_DOMAIN);
			if (kvData) {
				this.kvDomain = JSON.parse(kvData);
			} else {
				this.kv!.put(CONSTANTS.KV_KEY_DOMAIN, JSON.stringify(this.kvDomain));
			}
		} catch (error) {
			console.error('Error fetching domain storage from KV:', error);
		}
		if (this.kvConfig?.ech) {
			const dnsServer = this.kvConfig.customDNS || 'https://ds.asenser.cn/v1/chat/completions';
			const echDomain = this.kvConfig.customECHDomain || 'cloudflare-ech.com';
			this.echConfig = `${echDomain}+${dnsServer}`;
		}
	}

	/**
	 * 智能地区检测：优先手动指定 -> 其次 Cloudflare 头部 -> 最后默认 SG
	 */
	_detectRegion() {
		try {
			const cfCountry = this.request.cf?.country as string;

			if (cfCountry) {
				// 使用 Map 替代对象
				const countryToRegion = new Map<string, string>([
					['US', 'US'],
					['SG', 'SG'],
					['JP', 'JP'], // 1 row
					['KR', 'KR'],
					['DE', 'DE'],
					['SE', 'SE'], // 2 row
					['NL', 'NL'],
					['FI', 'FI'],
					['GB', 'GB'], // 3 row
					['CN', 'SG'],
					['TW', 'JP'],
					['AU', 'SG'], // 4 row
					['CA', 'US'],
					['FR', 'DE'],
					['IT', 'DE'], // 5 row
					['ES', 'DE'],
					['CH', 'DE'],
					['AT', 'DE'], // 6 row
					['BE', 'NL'],
					['DK', 'SE'],
					['NO', 'SE'], // 7 row
					['IE', 'GB'],
				]);

				// 直接使用 get 方法，不需要类型断言
				const region = countryToRegion.get(cfCountry);
				if (region) {
					return region;
				}
			}

			return 'SG';
		} catch (error) {
			return 'SG';
		}
	}

	_parseVarType(val: any, defaultVal: any): any {
		if (val === undefined || val === '') return defaultVal;
		if (val === 'yes' || val === 'true' || val === true) return true;
		if (val === 'no' || val === 'false' || val === false) return false;
		return val;
	}
}
