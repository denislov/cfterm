import { KVConfig, SSConfig } from "../types";
import { Utils } from "../Utils";
import { CONSTANTS } from "./Constants";

export class WorkerContext {
	readonly request: Request;
	readonly env: Env
	readonly executionCtx: ExecutionContext;
	readonly url: URL;
	readonly uuid: string;
	readonly kv: KVNamespace | null;
	featureFlags: Record<string, boolean>;
	enableRegionMatching: boolean = true;
	isAuth: boolean = false;
	region: string;
	kvConfig: KVConfig;
	socksConfig?: SSConfig;
	fallbackAddress?: string;
	state: Map<string, any>;

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
	}

	async loadKVConfig() {
		if (!this.kv) {
			return;
		}

		try {
			const configData = await this.kv.get('c');
			if (!configData) {
				this.kv.put('c', JSON.stringify(CONSTANTS.KV_CONFIG_DEFAULTS));
				return;
			};

			const configJson = JSON.parse(configData);

			// 遍历配置项进行赋值
			Object.entries(CONSTANTS.KV_CONFIG_DEFAULTS).forEach(([key, defaultValue]) => {
				this.kvConfig[key] = this._parseBool(configJson[key], defaultValue as boolean);
			});

			// 处理非布尔类型的配置项
			if (configJson.socksAddress) {
				this.kvConfig.socksAddress = configJson.socksAddress;
			}
			if (configJson.fallbackAddress) {
				this.kvConfig.fallbackAddress = configJson.fallbackAddress;
			}

			// 解析 SOCKS 配置
			this.socksConfig = Utils.parseSocksConfig(this.kvConfig.socksAddress || '');
			this.fallbackAddress = this.kvConfig.fallbackAddress || '';

		} catch (error) {
			// 使用默认配置
			console.warn('[KV] load config failed, using defaults', error);
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
					['US', 'US'], ['SG', 'SG'], ['JP', 'JP'], ['KR', 'KR'],
					['DE', 'DE'], ['SE', 'SE'], ['NL', 'NL'], ['FI', 'FI'], ['GB', 'GB'],
					['CN', 'SG'], ['TW', 'JP'], ['AU', 'SG'], ['CA', 'US'],
					['FR', 'DE'], ['IT', 'DE'], ['ES', 'DE'], ['CH', 'DE'],
					['AT', 'DE'], ['BE', 'NL'], ['DK', 'SE'], ['NO', 'SE'], ['IE', 'GB']
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

	_parseBool(val: string, defaultVal: boolean): boolean {
		if (val === undefined || val === '') return defaultVal;
		return val === 'yes' || val === 'true';
	}
}