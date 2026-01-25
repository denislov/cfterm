import { KVConfig } from "../types";

const CONSTANTS = {
	DEFAULT_UUID: '351c9981-04b6-4103-aa4b-864aa9c91469',
	KV_KEY_DOMAINs: 'domains',
	// 优选 IP API 地址
	PREFERRED_IP_URL: 'https://raw.githubusercontent.com/qwer-search/bestip/refs/heads/main/kejilandbestip.txt',
	// 订阅转换后端
	SUB_CONVERTER_URL: 'https://url.v1.mk/sub',
	// 正则表达式预编译
	REGEX: {
		UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		IPV4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
		IPV6: /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
		IPV6SHORT: /^::1$|^::$|^(?:[0-9a-fA-F]{1,4}:)*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$/,
		DOMAIN: /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
	},
	// HTML缓存TTL（秒）
	HTML_CACHE_TTL: 3600,
	INDEX_HTML_URL: 'https://raw.githubusercontent.com/denislov/cfterm/refs/heads/master/assets/index.html',
	TERM_HTML_URL: 'https://raw.githubusercontent.com/denislov/cfterm/refs/heads/master/assets/terminal.html',
	KV_CONFIG_DEFAULTS: {
		epd: true,
		epi: false,
		egi: false,
		dkby: true,
		ipv4: true,
		ipv6: false,
		ispMobile: false,
		ispUnicom: true,
		ispTelecom: true,
		ev: true,
		et: false,
		ex: false,
		ech: true,
		ae: true,
		enableSocksDowngrade: true,
		isSocksEnabled: false,
	} as KVConfig,
	HEX_TABLE: Array.from({ length: 256 }, (v, i) => (i + 256).toString(16).slice(1)),
	BUFFER_SIZE: 640 * 1024,
	FLUSH_TIME: 2,
	SAFE_BUFFER_SIZE: 640 * 1024 - 4096,
	STRATEGY_ORDER: ['socks', 'http'],
};

const BACKUP_IPS = [
	{ domain: 'ProxyIP.US.CMLiussss.net', region: 'US', regionCode: 'US', port: 443 },
	{ domain: 'ProxyIP.SG.CMLiussss.net', region: 'SG', regionCode: 'SG', port: 443 },
	{ domain: 'ProxyIP.JP.CMLiussss.net', region: 'JP', regionCode: 'JP', port: 443 },
	{ domain: 'ProxyIP.KR.CMLiussss.net', region: 'KR', regionCode: 'KR', port: 443 },
	{ domain: 'ProxyIP.DE.CMLiussss.net', region: 'DE', regionCode: 'DE', port: 443 },
	{ domain: 'ProxyIP.SE.CMLiussss.net', region: 'SE', regionCode: 'SE', port: 443 },
	{ domain: 'ProxyIP.NL.CMLiussss.net', region: 'NL', regionCode: 'NL', port: 443 },
	{ domain: 'ProxyIP.FI.CMLiussss.net', region: 'FI', regionCode: 'FI', port: 443 },
	{ domain: 'ProxyIP.GB.CMLiussss.net', region: 'GB', regionCode: 'GB', port: 443 },
	{ domain: 'ProxyIP.Oracle.cmliussss.net', region: 'Oracle', regionCode: 'Oracle', port: 443 },
	{ domain: 'ProxyIP.DigitalOcean.CMLiussss.net', region: 'DigitalOcean', regionCode: 'DigitalOcean', port: 443 },
	{ domain: 'ProxyIP.Vultr.CMLiussss.net', region: 'Vultr', regionCode: 'Vultr', port: 443 },
	{ domain: 'ProxyIP.Multacom.CMLiussss.net', region: 'Multacom', regionCode: 'Multacom', port: 443 }
];

// 静态资源：直连域名列表
const CF_BEST_DOMAINS = [
	{ name: '182682.xyz', domain: 'cloudflare.182682.xyz' },
	{ name: 'JP-AI', domian: 'jp.111000.cc.cd' },
];

// 错误提示常量
const ERRORS = {
	E_INVALID_DATA: atob('aW52YWxpZCBkYXRh'),
	E_INVALID_USER: atob('aW52YWxpZCB1c2Vy'),
	E_UNSUPPORTED_CMD: atob('Y29tbWFuZCBpcyBub3Qgc3VwcG9ydGVk'),
	E_UDP_DNS_ONLY: atob('VURQIHByb3h5IG9ubHkgZW5hYmxlIGZvciBETlMgd2hpY2ggaXMgcG9ydCA1Mw=='),
	E_INVALID_ADDR_TYPE: atob('aW52YWxpZCBhZGRyZXNzVHlwZQ=='),
	E_EMPTY_ADDR: atob('YWRkcmVzc1ZhbHVlIGlzIGVtcHR5'),
	E_WS_NOT_OPEN: atob('d2ViU29ja2V0LmVhZHlTdGF0ZSBpcyBub3Qgb3Blbg=='),
	E_INVALID_ID_STR: atob('U3RyaW5naWZpZWQgaWRlbnRpZmllciBpcyBpbnZhbGlk'),
	E_INVALID_SOCKS_ADDR: atob('SW52YWxpZCBTT0NLUyBhZGRyZXNzIGZvcm1hdA=='),
	E_SOCKS_NO_METHOD: atob('bm8gYWNjZXB0YWJsZSBtZXRob2Rz'),
	E_SOCKS_AUTH_NEEDED: atob('c29ja3Mgc2VydmVyIG5lZWRzIGF1dGg='),
	E_SOCKS_AUTH_FAIL: atob('ZmFpbCB0byBhdXRoIHNvY2tzIHNlcnZlcg=='),
	E_SOCKS_CONN_FAIL: atob('ZmFpbCB0byBvcGVuIHNvY2tzIGNvbm5lY3Rpb24='),
};
export { CONSTANTS, BACKUP_IPS, CF_BEST_DOMAINS, ERRORS };