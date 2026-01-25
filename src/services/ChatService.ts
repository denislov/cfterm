import { connect } from 'cloudflare:sockets';
import { BACKUP_IPS, CONSTANTS, ERRORS } from '../core/Constants';
import { WorkerContext } from '../core/Context';
import { ADDRESS_TYPE, AuthParams, ParsedRequest, StrategyFn, StrategyItem } from '../types';
import { Utils } from '../Utils';
import { VParser } from '../protocols/VParser';

export class ChatService {
	private ctx: WorkerContext;
	strategyExecutorMap: Map<number, StrategyFn>;
	// 常用工具
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	constructor(ctx: WorkerContext) {
		this.ctx = ctx;
		// 策略执行 Map

		this.strategyExecutorMap = new Map<number, StrategyFn>([
			[
				0,
				async ({ port, hostname }) => {
					return this.createConnect(hostname, port);
				},
			],
			[
				1,
				async ({ addrType, port, hostname }, param) => {
					const socksAuth = this.parseAuthString(param);
					return this.connectViaSocksProxy(addrType, hostname, port, socksAuth);
				},
			],
			[
				2,
				async ({ port, hostname }, param) => {
					const httpAuth = this.parseAuthString(param);
					return this.connectViaHttpProxy(port, httpAuth, hostname);
				},
			],
			[
				3,
				async (_parsedRequest, param) => {
					const [host, portStr] = this.parseHostPort(param, 443);
					return this.createConnect(host, Number(portStr));
				},
			],
		]);
	}

	async handleUpgrade() {
		const wsPair = new WebSocketPair();
		const clientSock = wsPair[0];
		const serverSock = wsPair[1];

		serverSock.accept();

		let isDnsQuery = false;
		let protocolType: string | null = null;

		const earlyData = this.ctx.request.headers.get(atob('c2VjLXdlYnNvY2tldC1wcm90b2NvbA==')) || '';
		const readable = this.makeReadableStream(serverSock, earlyData);

		let tcpSocket: Socket | null = null;
		let messageHandler: ((chunk: Uint8Array) => void) | undefined;

		const closeSocket = () => {
			if (!earlyData) {
				try {
					tcpSocket?.close();
				} catch {}
				try {
					serverSock?.close();
				} catch {}
			}
		};
		readable
			.pipeTo(
				new WritableStream({
					write: async (chunk) => {
						const u8chunk = await Utils.toU8(chunk);
						if (isDnsQuery) {
							return await this.forwardUDP(u8chunk, serverSock, null);
						}
						if (messageHandler) {
							return messageHandler(chunk);
						}

						if (!protocolType) {
							if (u8chunk.byteLength >= 24) {
								const vResult = VParser.parseHeader(u8chunk, this.ctx.uuid);
								if (!vResult.hasError) {
									protocolType = atob('dmxlc3M=');
									const { addressType, port, hostname, rawIndex, version, isUDP } = vResult;
									if (isUDP) {
										if (port === 53) isDnsQuery = true;
										else throw new Error(ERRORS.E_UDP_DNS_ONLY);
									}
									const respHeader = new Uint8Array([version![0], 0]);
									serverSock.send(respHeader);
									const rawData = u8chunk.subarray(rawIndex);

									if (isDnsQuery) return this.forwardUDP(rawData, serverSock, respHeader);
									try {
										tcpSocket = await this.establishTcpConnection(
											{ hostname: hostname!, port: port!, addrType: addressType!, dataOffset: rawIndex! },
											this.ctx.request,
										);
									} catch {
										tcpSocket = null;
									}
									if (!tcpSocket) {
										closeSocket();
										return;
									}
									const tcpWriter = tcpSocket.writable.getWriter();

									// 写入头部携带的 Payload
									if (rawData.byteLength) {
										await tcpWriter.write(rawData);
									}

									// 锁定状态：后续数据直接透传
									messageHandler = (data) => tcpWriter.write(data);
									this.manualPipe(tcpSocket.readable, serverSock);
									return;
								}
							}
							throw new Error('Invalid protocol or authentication failed');
						}
					},
				}),
			)
			.catch((err) => {
				console.error('Stream Error：', err.message);
			});

		return new Response(null, {
			status: 101,
			webSocket: clientSock,
		});
	}

	// =========================================
	// 2. 辅助函数
	// =========================================

	parseHostPort(addr: string, defaultPort: number): [string, string] {
		// 处理 IPv6 [::1]:80 格式
		if (addr.charCodeAt(0) === 91) {
			// '['
			const sepIndex = addr.indexOf(']:');
			if (sepIndex !== -1) return [addr.substring(0, sepIndex + 1), addr.substring(sepIndex + 2)];
			return [addr, defaultPort.toString()];
		}
		// 处理特殊 .tp 域名逻辑 (保留原逻辑)
		const tpIndex = addr.indexOf('.tp');
		const lastColon = addr.lastIndexOf(':');
		if (tpIndex !== -1 && lastColon === -1) {
			return [addr, addr.substring(tpIndex + 3, addr.indexOf('.', tpIndex + 3))];
		}
		if (lastColon === -1) return [addr, defaultPort.toString()];
		return [addr.substring(0, lastColon), addr.substring(lastColon + 1)];
	}

	parseAuthString(authParam: string): AuthParams {
		let username, password, hostStr;
		const atIndex = authParam.lastIndexOf('@');
		if (atIndex === -1) {
			hostStr = authParam;
		} else {
			const cred = authParam.substring(0, atIndex);
			hostStr = authParam.substring(atIndex + 1);
			const colonIndex = cred.indexOf(':');
			if (colonIndex === -1) {
				username = cred;
			} else {
				username = cred.substring(0, colonIndex);
				password = cred.substring(colonIndex + 1);
			}
		}
		const [hostname, portStr] = this.parseHostPort(hostStr, 1080);
		return { username, password, hostname, port: Number(portStr) };
	}

	// =========================================
	// 4. 连接策略与 Socket 处理
	// =========================================

	async createConnect(hostname: string, port: number): Promise<Socket> {
		const socket = connect({ hostname, port });
		return socket.opened.then(() => socket);
	}

	staticHeaders = `User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36\r\nProxy-Connection: Keep-Alive\r\nConnection: Keep-Alive\r\n\r\n`;
	encodedStaticHeaders = this.textEncoder.encode(this.staticHeaders);

	async connectViaHttpProxy(targetPortNum: number, httpAuth: AuthParams, httpHost: string): Promise<Socket | null> {
		const { username, password, hostname, port } = httpAuth;
		const proxySocket = await this.createConnect(hostname, port);
		const writer = proxySocket.writable.getWriter();

		let dynamicHeaders = `CONNECT ${httpHost}:${targetPortNum} HTTP/1.1\r\nHost: ${httpHost}:${targetPortNum}\r\n`;
		if (username) {
			dynamicHeaders += `Proxy-Authorization: Basic ${btoa(`${username}:${password || ''}`)}\r\n`;
		}

		const fullHeaders = new Uint8Array(dynamicHeaders.length * 3 + this.encodedStaticHeaders.length);
		const { written } = this.textEncoder.encodeInto(dynamicHeaders, fullHeaders);
		// @ts-ignore: written is possibly undefined in some TS definitions
		fullHeaders.set(encodedStaticHeaders, written);
		// @ts-ignore
		await writer.write(fullHeaders.subarray(0, written + encodedStaticHeaders.length));
		writer.releaseLock();

		const reader = proxySocket.readable.getReader();
		const buffer = new Uint8Array(256);
		let bytesRead = 0;
		let statusChecked = false;

		// 解析 HTTP 响应头
		try {
			while (bytesRead < buffer.length) {
				const { value, done } = await reader.read();
				if (done || bytesRead + value.length > buffer.length) return null;

				const prevBytesRead = bytesRead;
				buffer.set(value, bytesRead);
				bytesRead += value.length;

				if (!statusChecked && bytesRead >= 12) {
					// 检查 'HTTP/1.1 200' 的 '2' (ASCII 50)
					if (buffer[9] !== 50) return null;
					statusChecked = true;
				}

				const searchStart = Math.max(15, prevBytesRead - 3);
				for (let i = searchStart; i <= bytesRead - 4; i++) {
					if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
						// 找到 \r\n\r\n
						reader.releaseLock();
						if (bytesRead > i + 4) {
							// 还有多余的数据，需要回填
							const { readable, writable } = new TransformStream();
							const remainingWriter = writable.getWriter();
							remainingWriter.write(buffer.subarray(i + 4, bytesRead));
							remainingWriter.releaseLock();
							proxySocket.readable.pipeTo(writable).catch(() => {});
							// 替换 socket 的 readable 为回填后的 stream
							// @ts-ignore: hacky overwrite
							proxySocket.readable = readable;
						}
						return proxySocket;
					}
				}
			}
		} catch {
			return null;
		}
		return null;
	}

	async connectViaSocksProxy(addrType: ADDRESS_TYPE, address: string, port: number, socksAuth: AuthParams) {
		const { username, password, hostname, port: socksPort } = socksAuth!;
		const socket = await this.createConnect(hostname, socksPort);
		const writer = socket.writable.getWriter();
		await writer.write(new Uint8Array(username ? [5, 2, 0, 2] : [5, 1, 0]));
		const reader = socket.readable.getReader();
		let res = (await reader.read()).value;
		if (res[0] !== 5 || res[1] === 255) throw new Error(ERRORS.E_SOCKS_NO_METHOD);
		if (res[1] === 2) {
			if (!username || !password) throw new Error(ERRORS.E_SOCKS_AUTH_NEEDED);
			const encoder = new TextEncoder();
			const authRequest = new Uint8Array([1, username.length, ...encoder.encode(username), password.length, ...encoder.encode(password)]);
			await writer.write(authRequest);
			res = (await reader.read()).value;
			if (res[0] !== 1 || res[1] !== 0) throw new Error(ERRORS.E_SOCKS_AUTH_FAIL);
		}
		const encoder = new TextEncoder();
		let DSTADDR;
		switch (addrType) {
			case ADDRESS_TYPE.IPV4:
				DSTADDR = new Uint8Array([1, ...address.split('.').map(Number)]);
				break;
			case ADDRESS_TYPE.URL:
				DSTADDR = new Uint8Array([3, address.length, ...encoder.encode(address)]);
				break;
			case ADDRESS_TYPE.IPV6:
				DSTADDR = new Uint8Array([4, ...address.split(':').flatMap((x) => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)])]);
				break;
			default:
				throw new Error(ERRORS.E_INVALID_ADDR_TYPE);
		}
		await writer.write(new Uint8Array([5, 1, 0, ...DSTADDR, port >> 8, port & 255]));
		res = (await reader.read()).value;
		if (res[1] !== 0) throw new Error(ERRORS.E_SOCKS_CONN_FAIL);
		writer.releaseLock();
		reader.releaseLock();
		return socket;
	}
	// =========================================
	// 5. 核心逻辑：建立连接与数据管道
	// =========================================

	async establishTcpConnection(parsedRequest: ParsedRequest, request: Request): Promise<Socket | null> {
		const url = request.url;
		const clean = url.slice(url.indexOf('/', 10) + 1, url.charCodeAt(url.length - 1) === 47 ? -1 : undefined);
		const list: StrategyItem[] = [];

		// [优化] 将 Regex 移入函数内，避免并发状态共享问题
		const paramRegex = /(gs5|s5all|ghttp|httpall|s5|socks|http|ip)(?:=|:\/\/|%3A%2F%2F)([^&]+)|(proxyall|globalproxy)/gi;

		if (clean.length < 6) {
			list.push({ type: 0 }, { type: 3, param: (await this.getBestBackupIP())?.domain ?? BACKUP_IPS[0].domain });
		} else {
			let m;
			const p: Record<string, string | boolean> = Object.create(null);
			while ((m = paramRegex.exec(clean))) {
				const key = (m[1] || m[3]).toLowerCase();
				const value = m[2] ? (m[2].charCodeAt(m[2].length - 1) === 61 ? m[2].slice(0, -1) : m[2]) : true;
				p[key] = value;
			}

			const s5 = (p.gs5 || p.s5all || p.s5 || p.socks) as string;
			const http = (p.ghttp || p.httpall || p.http) as string;
			const ip = p.ip as string;
			const proxyAll = !!(p.gs5 || p.s5all || p.ghttp || p.httpall || p.proxyall || p.globalproxy);

			if (!proxyAll) list.push({ type: 0 });

			const add = (v: string, t: number) => {
				if (!v) return;
				const parts = decodeURIComponent(v).split(',');
				for (const part of parts) if (part) list.push({ type: t, param: part });
			};

			for (const k of CONSTANTS.STRATEGY_ORDER) {
				if (k === 'socks') add(s5, 1);
				else if (k === 'http') add(http, 2);
			}

			if (proxyAll) {
				if (!list.length) list.push({ type: 0 });
			} else {
				add(ip, 3);
				const bestBackupIP = await this.getBestBackupIP(this.ctx.region);
				list.push({ type: 3, param: bestBackupIP?.domain ?? BACKUP_IPS[1].domain });
			}
		}
		for (const item of list) {
			try {
				const executor = this.strategyExecutorMap.get(item.type);
				if (executor) {
					const socket = await executor(parsedRequest, item.param || '');
					if (socket) return socket;
				}
			} catch {
				// ignore specific connection errors, try next
			}
		}
		return null;
	}

	// [优化] 安全的 Buffer 大小，保留 4KB 余量

	/**
	 * 手动实现的 pipeTo，包含 buffer 逻辑
	 * 优化点：使用 subarray 避免内存复制
	 */
	async manualPipe(readable: ReadableStream, writable: WebSocket) {
		let buffer = new Uint8Array(CONSTANTS.BUFFER_SIZE);
		let offset = 0;
		let timerId: ReturnType<typeof setTimeout> | null = null;
		let resume: ((value?: unknown) => void) | null = null;

		const flushBuffer = () => {
			if (offset > 0) {
				// [优化] 零拷贝发送
				writable.send(buffer.subarray(0, offset));
				offset = 0;
			}
			if (timerId) {
				clearTimeout(timerId);
				timerId = null;
			}
			if (resume) {
				resume();
				resume = null;
			}
		};

		const reader = readable.getReader();
		try {
			while (true) {
				const { done, value: chunk } = await reader.read();
				if (done) break;

				// [优化] 大包直接发送，不进入 Buffer
				if (chunk.length > 4096 || offset + chunk.length > CONSTANTS.BUFFER_SIZE) {
					flushBuffer(); // 清空旧的
					writable.send(chunk);
				} else {
					// 小包合并
					buffer.set(chunk, offset);
					offset += chunk.length;

					if (!timerId) {
						timerId = setTimeout(flushBuffer, CONSTANTS.FLUSH_TIME);
					}

					// 背压控制
					if (offset > CONSTANTS.SAFE_BUFFER_SIZE) {
						await new Promise((resolve) => (resume = resolve));
					}
				}
			}
		} finally {
			flushBuffer();
			reader.releaseLock();
		}
	}

	makeReadableStream(socket: WebSocket, earlyDataHeader: string) {
		let cancelled = false;
		return new ReadableStream({
			start(controller) {
				socket.addEventListener('message', (event) => {
					if (!cancelled) controller.enqueue(event.data);
				});
				socket.addEventListener('close', () => {
					if (!cancelled) {
						controller?.close();
					}
				});
				socket.addEventListener('error', (err) => controller.error(err));
				const { earlyData, error } = Utils.base64ToArray(earlyDataHeader);
				if (error) controller.error(error);
				else if (earlyData) controller.enqueue(earlyData);
			},
			cancel() {
				cancelled = true;
				Utils.closeSocketQuietly(socket);
			},
		});
	}

	async forwardUDP(udpChunk: any, webSocket: WebSocket, respHeader: Uint8Array<ArrayBuffer> | null) {
		try {
			const tcpSocket = connect({ hostname: '8.8.4.4', port: 53 });
			let header = respHeader;
			const writer = tcpSocket.writable.getWriter();
			await writer.write(udpChunk);
			writer.releaseLock();
			await tcpSocket.readable.pipeTo(
				new WritableStream({
					async write(chunk) {
						if (webSocket.readyState === 1) {
							if (header) {
								webSocket.send(await new Blob([header, chunk]).arrayBuffer());
								header = null;
							} else {
								webSocket.send(chunk);
							}
						}
					},
				}),
			);
		} catch (error) {}
	}

	async getBestBackupIP(workerRegion = '') {
		if (BACKUP_IPS.length === 0) {
			return null;
		}

		const availableIPs = BACKUP_IPS.map((ip) => ({ ...ip, available: true }));

		if (this.ctx.enableRegionMatching && workerRegion) {
			const sortedIPs = this.getSmartRegionSelection(workerRegion, availableIPs);
			if (sortedIPs.length > 0) {
				const selectedIP = sortedIPs[0];
				return selectedIP;
			}
		}

		const selectedIP = availableIPs[0];
		return selectedIP;
	}
	getSmartRegionSelection(
		workerRegion: string,
		availableIPs: {
			available: boolean;
			domain: string;
			region: string;
			regionCode: string;
			port: number;
		}[],
	) {
		if (!this.ctx.enableRegionMatching || !workerRegion) {
			return availableIPs;
		}

		const priorityRegions = Utils.getAllRegionsByPriority(workerRegion);

		const sortedIPs = [];

		for (const region of priorityRegions) {
			const regionIPs = availableIPs.filter((ip) => ip.regionCode === region);
			sortedIPs.push(...regionIPs);
		}

		return sortedIPs;
	}
}
