import { BACKUP_IPS, CONSTANTS, ERRORS } from "./core/Constants";
import { WorkerContext } from "./core/Context";
import { SSConfig } from "./types";

export class Utils {
	// ==========================================
	// 1. 校验与正则类
	// ==========================================

	static isUuid(str: string) {
		return CONSTANTS.REGEX.UUID.test(str);
	}

	static isIp(ip: string) {
		return CONSTANTS.REGEX.IPV4.test(ip) || CONSTANTS.REGEX.IPV6.test(ip) || CONSTANTS.REGEX.IPV6SHORT.test(ip);
	}

	static isDomain(domain: string) {
		return CONSTANTS.REGEX.DOMAIN.test(domain);
	}

	// ==========================================
	// 2. 解析类
	// ==========================================

	/**
	 * 解析 "host:port" 或 "[ipv6]:port" 或 "host" 字符串
	 */

	static parseAddress(input: string) {
		if (!input) return {
			address: '',
			port: null
		};

		// 处理 IPv6 [::1]:8080 格式
		if (input.includes('[') && input.includes(']')) {
			const match = input.match(/^\[([^\]]+)\](?::(\d+))?$/);
			if (match) {
				return {
					address: match[1],
					port: match[2] ? parseInt(match[2], 10) : null
				};
			}
		}

		const lastColonIndex = input.lastIndexOf(':');
		// 处理 IPv4:Port 或 Domain:Port
		if (lastColonIndex > 0) {
			const address = input.substring(0, lastColonIndex);
			const portStr = input.substring(lastColonIndex + 1);
			const port = parseInt(portStr, 10);
			if (!isNaN(port) && port > 0 && port <= 65535) {
				return {
					address,
					port
				};
			}
		}

		return {
			address: input,
			port: null
		};
	}

	static parseSocksConfig(configStr: string) {
		if (!configStr) return undefined;
		try {
			let [latter, former] = configStr.split("@").reverse();
			let username = '', password = '', hostname, socksPort;

			if (former) {
				const formers = former.split(":");
				if (formers.length !== 2) throw new Error('Invalid Socks Auth');
				[username, password] = formers;
			}

			const latters = latter.split(":");
			socksPort = Number(latters.pop());
			if (isNaN(socksPort)) throw new Error('Invalid Socks Port');

			hostname = latters.join(":");
			return {
				username,
				password,
				hostname,
				socksPort
			} as SSConfig;
		} catch (e) {
			throw e;
		}
	}

	// ==========================================
	// 3. 转换与格式化
	// ==========================================

	static base64ToArray(b64Str: string) {
		if (!b64Str) return {
			error: null
		};
		try {
			b64Str = b64Str.replace(/-/g, '+').replace(/_/g, '/');
			return {
				earlyData: Uint8Array.from(atob(b64Str), (c) => c.charCodeAt(0)).buffer,
				error: null
			};
		} catch (error) {
			return {
				error
			};
		}
	}
	static closeSocketQuietly(socket: WebSocket) { try { if (socket.readyState === 1 || socket.readyState === 2) socket.close(); } catch (error) { } }
	static getNearbyRegions(region: string) {
		const nearby: Record<string, string[]> = {
			US: ['SG', 'JP', 'KR'],
			SG: ['JP', 'KR', 'US'],
			JP: ['SG', 'KR', 'US'],
			KR: ['JP', 'SG', 'US'],
			DE: ['NL', 'GB', 'SE', 'FI'],
			SE: ['DE', 'NL', 'FI', 'GB'],
			NL: ['DE', 'GB', 'SE', 'FI'],
			FI: ['SE', 'DE', 'NL', 'GB'],
			GB: ['DE', 'NL', 'SE', 'FI'],
		};

		return nearby[region] ?? [];
	}

	static getAllRegionsByPriority(region: string) {
		const nearbyRegions = Utils.getNearbyRegions(region);
		const allRegions = ['US', 'SG', 'JP', 'KR', 'DE', 'SE', 'NL', 'FI', 'GB'];

		return [region, ...nearbyRegions, ...allRegions.filter(r => r !== region && !nearbyRegions.includes(r))];
	}
	/**
	 * 将字节数组转为 UUID 字符串 (xxxxxxxx-xxxx-xxxx-...)
	 */
	static uuidFromBytes(arr: Uint8Array, offset = 0) {
		const hexTable = Array.from({
			length: 256
		}, (v, i) => (i + 256).toString(16).slice(1));
		const id = (
			hexTable[arr[offset]] + hexTable[arr[offset + 1]] + hexTable[arr[offset + 2]] + hexTable[arr[offset + 3]] + "-" +
			hexTable[arr[offset + 4]] + hexTable[arr[offset + 5]] + "-" +
			hexTable[arr[offset + 6]] + hexTable[arr[offset + 7]] + "-" +
			hexTable[arr[offset + 8]] + hexTable[arr[offset + 9]] + "-" +
			hexTable[arr[offset + 10]] + hexTable[arr[offset + 11]] + hexTable[arr[offset + 12]] + hexTable[arr[offset + 13]] + hexTable[arr[offset + 14]] + hexTable[arr[offset + 15]]
		).toLowerCase();
		return id;
	}
	static formatIdentifier(arr: any, offset = 0) {
		const id = (CONSTANTS.HEX_TABLE[arr[offset]] + CONSTANTS.HEX_TABLE[arr[offset + 1]] + CONSTANTS.HEX_TABLE[arr[offset + 2]] + CONSTANTS.HEX_TABLE[arr[offset + 3]] + "-" + CONSTANTS.HEX_TABLE[arr[offset + 4]] + CONSTANTS.HEX_TABLE[arr[offset + 5]] + "-" + CONSTANTS.HEX_TABLE[arr[offset + 6]] + CONSTANTS.HEX_TABLE[arr[offset + 7]] + "-" + CONSTANTS.HEX_TABLE[arr[offset + 8]] + CONSTANTS.HEX_TABLE[arr[offset + 9]] + "-" + CONSTANTS.HEX_TABLE[arr[offset + 10]] + CONSTANTS.HEX_TABLE[arr[offset + 11]] + CONSTANTS.HEX_TABLE[arr[offset + 12]] + CONSTANTS.HEX_TABLE[arr[offset + 13]] + CONSTANTS.HEX_TABLE[arr[offset + 14]] + CONSTANTS.HEX_TABLE[arr[offset + 15]]).toLowerCase();
		if (Utils.isUuid(id)) throw new TypeError(ERRORS.E_INVALID_ID_STR);
		return id;
	}
	static getSmartRegionSelection(workerRegion: string, availableIPs: {
		available: boolean;
		domain: string;
		region: string;
		regionCode: string;
		port: number;
	}[], ctx: WorkerContext) {

		if (!ctx.enableRegionMatching || !workerRegion) {
			return availableIPs;
		}

		const priorityRegions = Utils.getAllRegionsByPriority(workerRegion);

		const sortedIPs = [];

		for (const region of priorityRegions) {
			const regionIPs = availableIPs.filter(ip => ip.regionCode === region);
			sortedIPs.push(...regionIPs);
		}

		return sortedIPs;
	}
	static getBestBackupIP(workerRegion = '', ctx: WorkerContext) {

		if (BACKUP_IPS.length === 0) {
			return null;
		}

		const availableIPs = BACKUP_IPS.map(ip => ({ ...ip, available: true }));

		if (ctx.enableRegionMatching && workerRegion) {
			const sortedIPs = Utils.getSmartRegionSelection(workerRegion, availableIPs, ctx);
			if (sortedIPs.length > 0) {
				const selectedIP = sortedIPs[0];
				return selectedIP;
			}
		}

		const selectedIP = availableIPs[0];
		return selectedIP;
	}
	// ==========================================
	// 4. Http 响应辅助
	// ==========================================

	static jsonResponse(data: {}, status = 200, headers = {}) {
		return new Response(JSON.stringify(data), {
			status,
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				...headers
			}
		});
	}

	static errorResponse(message: string, status = 400) {
		return Utils.jsonResponse({
			error: message
		}, status);
	}
	static _rightRotate(value: number, amount: number): number {
		return (value >>> amount) | (value << (32 - amount));
	}
	// ==========================================
	// 5. 加密算法 (Trojan hash)
	// ==========================================

	static async sha224(text: string) {
		const encoder = new TextEncoder();
		const data = encoder.encode(text);

		const K = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
			0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
			0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
			0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
			0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
			0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
			0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
		];

		let H = [
			0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
			0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4
		];

		const msgLen = data.length;
		const bitLen = msgLen * 8;
		const paddedLen = Math.ceil((msgLen + 9) / 64) * 64;
		const padded = new Uint8Array(paddedLen);
		padded.set(data);
		padded[msgLen] = 0x80;

		const view = new DataView(padded.buffer);
		view.setUint32(paddedLen - 4, bitLen, false);

		for (let chunk = 0; chunk < paddedLen; chunk += 64) {
			const W = new Uint32Array(64);

			for (let i = 0; i < 16; i++) {
				W[i] = view.getUint32(chunk + i * 4, false);
			}

			for (let i = 16; i < 64; i++) {
				const s0 = Utils._rightRotate(W[i - 15], 7) ^ Utils._rightRotate(W[i - 15], 18) ^ (W[i - 15] >>> 3);
				const s1 = Utils._rightRotate(W[i - 2], 17) ^ Utils._rightRotate(W[i - 2], 19) ^ (W[i - 2] >>> 10);
				W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
			}

			let [a, b, c, d, e, f, g, h] = H;

			for (let i = 0; i < 64; i++) {
				const S1 = Utils._rightRotate(e, 6) ^ Utils._rightRotate(e, 11) ^ Utils._rightRotate(e, 25);
				const ch = (e & f) ^ (~e & g);
				const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
				const S0 = Utils._rightRotate(a, 2) ^ Utils._rightRotate(a, 13) ^ Utils._rightRotate(a, 22);
				const maj = (a & b) ^ (a & c) ^ (b & c);
				const temp2 = (S0 + maj) >>> 0;

				h = g;
				g = f;
				f = e;
				e = (d + temp1) >>> 0;
				d = c;
				c = b;
				b = a;
				a = (temp1 + temp2) >>> 0;
			}

			H[0] = (H[0] + a) >>> 0;
			H[1] = (H[1] + b) >>> 0;
			H[2] = (H[2] + c) >>> 0;
			H[3] = (H[3] + d) >>> 0;
			H[4] = (H[4] + e) >>> 0;
			H[5] = (H[5] + f) >>> 0;
			H[6] = (H[6] + g) >>> 0;
			H[7] = (H[7] + h) >>> 0;
		}

		const result = [];
		for (let i = 0; i < 7; i++) {
			result.push(
				((H[i] >>> 24) & 0xff).toString(16).padStart(2, '0'),
				((H[i] >>> 16) & 0xff).toString(16).padStart(2, '0'),
				((H[i] >>> 8) & 0xff).toString(16).padStart(2, '0'),
				(H[i] & 0xff).toString(16).padStart(2, '0')
			);
		}

		return result.join('');
	}
}