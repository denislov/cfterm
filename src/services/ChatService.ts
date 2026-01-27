import { connect } from 'cloudflare:sockets';
import { BACKUP_IPS, CONSTANTS, ERRORS } from '../core/Constants';
import { WorkerContext } from '../core/Context';
import { ADDRESS_TYPE, AuthParams, ParsedRequest, ProtocolHeader, StrategyFn, StrategyItem } from '../types';
import { Utils } from '../Utils';
import { VParser } from '../protocols/VParser';
import { TParser } from '../protocols/TParser';

export class ChatService {
	private ctx: WorkerContext;
	strategyExecutorMap: Map<number, StrategyFn>;
	// 常用工具
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	staticHeaders = `User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36\r\nProxy-Connection: Keep-Alive\r\nConnection: Keep-Alive\r\n\r\n`;
	encodedStaticHeaders = this.textEncoder.encode(this.staticHeaders);
	paramRegex = /(gs5|s5all|ghttp|httpall|s5|socks|http|ip)(?:=|:\/\/|%3A%2F%2F)([^&]+)|(proxyall|globalproxy)/gi;

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
					const socksAuth = Utils.parseAuthString(param);
					return this.connectViaSocksProxy(addrType, hostname, port, socksAuth);
				},
			],
			[
				2,
				async ({ port, hostname }, param) => {
					const httpAuth = Utils.parseAuthString(param);
					return this.connectViaHttpProxy(port, httpAuth, hostname);
				},
			],
			[
				3,
				async (_parsedRequest, param) => {
					const { address, port } = Utils.parseAddress(param, 443);
					return this.createConnect(address, port!);
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

		const closeSocket = () => {
			if (tcpSocket) {
				try {
					tcpSocket.close();
				} catch { }
				try {
					Utils.closeSocketQuietly(serverSock);
				} catch { }
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
						if (tcpSocket) {
							const remoteWriter = tcpSocket.writable.getWriter();
							await remoteWriter.write(u8chunk);
							remoteWriter.releaseLock();
							return;
						}

						if (!protocolType) {
							if (this.ctx.kvConfig.ev && u8chunk.byteLength >= 24) {
								const vResult = VParser.parseHeader(u8chunk, this.ctx.uuid);
								if (!vResult.hasError) {
									protocolType = atob('dmxlc3M=');
									vResult;
									if (vResult.isUDP) {
										if (vResult.port === 53) isDnsQuery = true;
										else throw new Error(ERRORS.E_UDP_DNS_ONLY);
									}
									const respHeader = new Uint8Array([vResult.version![0], 0]);
									if (isDnsQuery) return this.forwardUDP(vResult.rawClientData, serverSock, respHeader);
									try {
										tcpSocket = await this.establishTcpConnection(
											{ hasError: false, addressType: vResult.addressType, port: vResult.port, hostname: vResult.hostname },
											this.ctx.request,
										);
									} catch {
										tcpSocket = null;
									}
									if (!tcpSocket) {
										closeSocket();
										return;
									}

									// 锁定状态：后续数据直接透传
									this.pipTcpToWs(tcpSocket, serverSock, vResult).catch(
										err => {
											console.error('PipeTcpToWs failed:', err);
											closeSocket();
										}
									);
									return;
								}
							}
							if (u8chunk.byteLength >= 56) {
								const tResult = await TParser.parseTrojanHeader(u8chunk, this.ctx.uuid);
								if (!tResult.hasError) {
									protocolType = atob('dHJvamFu');
									try {
										tcpSocket = await this.establishTcpConnection(
											{ hasError: false, addressType: tResult.addressType, port: tResult.port, hostname: tResult.hostname },
											this.ctx.request,
										);
									} catch {
										tcpSocket = null;
									}
									if (!tcpSocket) {
										closeSocket();
										return;
									}
									this.pipTcpToWs(tcpSocket, serverSock, tResult).catch(
										err => {
											console.error('PipeTcpToWs failed:', err);
											closeSocket();
										}
									);
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
				closeSocket();
			});

		return new Response(null, {
			status: 101,
			webSocket: clientSock,
		});
	}

	// =========================================
	// 4. 连接策略与 Socket 处理
	// =========================================

	async createConnect(hostname: string, port: number): Promise<Socket> {
		const socket = connect({ hostname, port });
		return socket.opened.then(() => socket);
	}

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
		fullHeaders.set(this.encodedStaticHeaders, written);
		await writer.write(fullHeaders.subarray(0, written + this.encodedStaticHeaders.length));
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
							proxySocket.readable.pipeTo(writable).catch(() => { });
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

	async establishTcpConnection(parsedRequest: ProtocolHeader, request: Request): Promise<Socket | null> {
		const url = request.url;
		const clean = url.slice(url.indexOf('/', 10) + 1, url.charCodeAt(url.length - 1) === 47 ? -1 : undefined);
		const list: StrategyItem[] = [];

		if (clean.length < 6) {
			list.push({ type: 0 }, { type: 3, param: Utils.getBestBackupIP(this.ctx)?.domain ?? BACKUP_IPS[0].domain });
		} else {
			this.paramRegex.lastIndex = 0;
			let m;
			const p: Record<string, string | boolean> = Object.create(null);
			while ((m = this.paramRegex.exec(clean))) {
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
				const bestBackupIP = Utils.getBestBackupIP(this.ctx);
				list.push({ type: 3, param: bestBackupIP?.domain ?? BACKUP_IPS[1].domain });
			}
		}
		for (const item of list) {
			try {
				const executor = this.strategyExecutorMap.get(item.type);
				if (executor) {
					const socket = await executor({
						addrType: parsedRequest!.addressType!,
						hostname: parsedRequest!.hostname!,
						port: parsedRequest!.port!,
					}, item.param || '');
					if (socket) return socket;
				}
			} catch {
				// ignore specific connection errors, try next
			}
		}
		return null;
	}

	async pipTcpToWs(remoteSocket: Socket, ws: WebSocket, respHeader: ProtocolHeader | null = null) {
		if (respHeader?.rawClientData?.byteLength) {
			const remoteWriter = remoteSocket.writable.getWriter();
			await remoteWriter.write(respHeader.rawClientData);
			remoteWriter.releaseLock();
		}
		// vless 可能有header version需要返回
		let header: Uint8Array | null = null;
		if (respHeader?.version) {
			header = new Uint8Array([respHeader!.version![0], 0]);
		}
		await remoteSocket.readable
			.pipeTo(
				new WritableStream({
					async write(chunk, controller) {
						if (ws.readyState !== 1) {
							controller.error(ERRORS.E_WS_NOT_OPEN);
						}
						if (header) {
							ws.send(await new Blob([header, chunk]).arrayBuffer());
							header = null;
						} else {
							ws.send(chunk);
						}
					},
					abort(reason) { },
				}),
			)
			.catch((error) => {
				Utils.closeSocketQuietly(ws);
			});
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
		} catch (error) { }
	}
}
