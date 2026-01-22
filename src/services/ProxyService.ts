import { connect } from "cloudflare:sockets";
import { BACKUP_IPS, ERRORS } from "../core/Constants";
import { WorkerContext } from "../core/Context";
import { ADDRESS_TYPE } from "../types";
import { Utils } from "../Utils";

export class ProxyService {
    private ctx: WorkerContext;

    constructor(ctx: WorkerContext) {
        this.ctx = ctx;
    }

    async handleUpgrade() {
        // 🛑 FIX 1: 安全获取 WebSocket 对象
        const wsPair = new WebSocketPair();
        const clientSock = wsPair[0];
        const serverSock = wsPair[1];
        
        serverSock.accept();

        let remoteConnWrapper: { socket: Socket | null } = { socket: null };
        let isDnsQuery = false;
        let protocolType: string | null = null;

        const earlyData = this.ctx.request.headers.get(atob('c2VjLXdlYnNvY2tldC1wcm90b2NvbA==')) || '';
        const readable = this._makeReadableStream(serverSock, earlyData);

        // 启动后台流处理（不阻塞 Response 返回）
        readable.pipeTo(new WritableStream({
            write: async (chunk) => {
                if (isDnsQuery) return await this.forwardUDP(chunk, serverSock);

                if (remoteConnWrapper.socket) {
                    const writer = remoteConnWrapper.socket.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                if (!protocolType) {
                    // 处理 VLESS 协议
                    if (this.ctx.kvConfig?.ev && chunk.byteLength >= 24) {
                        const vlessResult = this._parseWsPacketHeader(chunk, this.ctx.uuid);
                        if (!vlessResult.hasError) {
                            protocolType = 'vless';
                            const { addressType, port, hostname, rawIndex, version, isUDP } = vlessResult;
                            
                            if (isUDP) {
                                if (port === 53) {
                                    isDnsQuery = true;
                                    // UDP DNS 不需要标准响应头，直接转发
                                    const rawData = chunk.slice(rawIndex);
                                    return this.forwardUDP(rawData, serverSock);
                                } else {
                                    throw new Error(ERRORS.E_UDP_DNS_ONLY);
                                }
                            }

                            // 🛑 FIX 2: 准备响应头，但在连接成功后立即发送，不传给 forwardTCP 延迟发送
                            const respHeader = new Uint8Array([version![0], 0]);
                            const rawData = chunk.slice(rawIndex);
                            
                            await this.forwardTCP(addressType!, hostname!, port!, rawData, serverSock, respHeader, remoteConnWrapper);
                            return;
                        }
                    }

                    // 可以在这里添加 Trojan 的判断逻辑 (同上)

                    throw new Error('Invalid protocol or authentication failed');
                }
            },
        })).catch((err) => {
            console.error('Stream Error:', err);
            Utils.closeSocketQuietly(serverSock);
        });

        return new Response(null, {
            status: 101,
            webSocket: clientSock
        });
    }

    // 简化后的流管道：不再负责发头，只负责转发数据
    async connectStreams(remoteSocket: Socket, webSocket: WebSocket) {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    if (webSocket.readyState !== WebSocket.OPEN) {
                        controller.error(ERRORS.E_WS_NOT_OPEN);
                        return;
                    }
                    webSocket.send(chunk);
                },
                abort(reason) {
                    console.error('Remote stream aborted:', reason);
                },
            })
        ).catch((error) => {
            console.error('PipeTo Error:', error);
            Utils.closeSocketQuietly(webSocket);
        });
        // 不再需要 retryFunc，连接断开就是断开了
    }

    async establishSocksConnection(addrType: ADDRESS_TYPE, address: string, port: number) {
        // ... (保持原有的 SOCKS5 逻辑不变) ...
        const { username, password, hostname, socksPort } = this.ctx.socksConfig!;
        const socket = connect({ hostname, port: socksPort });
        const writer = socket.writable.getWriter();
        await writer.write(new Uint8Array(username ? [5, 2, 0, 2] : [5, 1, 0]));
        const reader = socket.readable.getReader();
        const readResult = await reader.read();
        if (readResult.done || !readResult.value) throw new Error(ERRORS.E_SOCKS_CONN_FAIL);
        let res = readResult.value;
        if (res[0] !== 5 || res[1] === 255) throw new Error(ERRORS.E_SOCKS_NO_METHOD);
        if (res[1] === 2) {
            if (!username || !password) throw new Error(ERRORS.E_SOCKS_AUTH_NEEDED);
            const encoder = new TextEncoder();
            const authRequest = new Uint8Array([1, username.length, ...encoder.encode(username), password.length, ...encoder.encode(password)]);
            await writer.write(authRequest);
            const authResult = await reader.read();
            if (authResult.done || !authResult.value) throw new Error(ERRORS.E_SOCKS_AUTH_FAIL);
            res = authResult.value;
            if (res[0] !== 1 || res[1] !== 0) throw new Error(ERRORS.E_SOCKS_AUTH_FAIL);
        }
        const encoder = new TextEncoder(); let DSTADDR;
        switch (addrType) {
            case ADDRESS_TYPE.IPV4: DSTADDR = new Uint8Array([1, ...address.split('.').map(Number)]); break;
            case ADDRESS_TYPE.URL: DSTADDR = new Uint8Array([3, address.length, ...encoder.encode(address)]); break;
            case ADDRESS_TYPE.IPV6: DSTADDR = new Uint8Array([4, ...address.split(':').flatMap(x => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)])]); break;
            default: throw new Error(ERRORS.E_INVALID_ADDR_TYPE);
        }
        await writer.write(new Uint8Array([5, 1, 0, ...DSTADDR, port >> 8, port & 255]));
        const connResult = await reader.read();
        if (connResult.done || !connResult.value) throw new Error(ERRORS.E_SOCKS_CONN_FAIL);
        res = connResult.value;
        if (res[1] !== 0) throw new Error(ERRORS.E_SOCKS_CONN_FAIL);
        writer.releaseLock(); reader.releaseLock();
        return socket;
    }

    async forwardTCP(addrType: ADDRESS_TYPE, host: string, portNum: number, rawData: any, ws: WebSocket, respHeader: Uint8Array, remoteConnWrapper: { socket: Socket | null; }) {

        const connectAndSend = async (address: string, port: number, useSocks = false) => {
            const remoteSock = useSocks ?
                await this.establishSocksConnection(addrType, address, port) :
                connect({ hostname: address, port: port });
            
            // 写入客户端请求数据 (Payload)
            const writer = remoteSock.writable.getWriter();
            await writer.write(rawData);
            writer.releaseLock();
            return remoteSock;
        }

        const enableSocksDowngrade = this.ctx.kvConfig?.enableSocksDowngrade ?? true;
        const isSocksEnabled = this.ctx.kvConfig?.isSocksEnabled ?? false;
        const currentWorkerRegion = this.ctx.region;

        const performConnection = async (useSocks: boolean) => {
            const socket = await connectAndSend(host, portNum, useSocks);
            remoteConnWrapper.socket = socket;
            
            // 🛑 FIX 1 (续): 连接成功后，立即发送响应头！
            ws.send(respHeader);

            // 建立反向管道
            this.connectStreams(socket, ws);
            return socket;
        };

        // 尝试连接逻辑（包含 Fallback）
        try {
            const useSocks = enableSocksDowngrade ? false : isSocksEnabled;
            await performConnection(useSocks);
        } catch (err) {
            console.log('[ProxyService] Initial connection failed, trying fallback...');
            
            // Fallback 逻辑
            let backupHost = host;
            let backupPort = portNum;
            
            if (this.ctx.fallbackAddress && this.ctx.fallbackAddress.trim()) {
                const parsed = Utils.parseAddress(this.ctx.fallbackAddress);
                backupHost = parsed.address;
                backupPort = parsed.port || portNum;
            } else {
                const bestBackupIP = await this.getBestBackupIP(currentWorkerRegion);
                if (bestBackupIP) {
                    backupHost = bestBackupIP.domain;
                    backupPort = bestBackupIP.port;
                }
            }

            try {
                // 如果开启了 downgrade，fallback 时尝试直连 (useSocks=false)
                // 否则保持原有的 socks 设置
                const fallbackUseSocks = enableSocksDowngrade ? false : isSocksEnabled;
                await performConnection(fallbackUseSocks); // 这里复用上面的 performConnection
            } catch (fallbackErr) {
                console.error('Fallback failed:', fallbackErr);
                Utils.closeSocketQuietly(ws);
            }
        }
    }

    async forwardUDP(udpChunk: any, webSocket: WebSocket) {
        // ... (保持原有的 UDP 逻辑不变) ...
        try {
            const tcpSocket = connect({ hostname: '8.8.4.4', port: 53 });
            const writer = tcpSocket.writable.getWriter();
            await writer.write(udpChunk);
            writer.releaseLock();
            await tcpSocket.readable.pipeTo(new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(chunk);
                    }
                },
            }));
        } catch (error) { }
    }

    async getBestBackupIP(workerRegion = '') {
        // ... (保持不变) ...
        if (BACKUP_IPS.length === 0) return null;
        const availableIPs = BACKUP_IPS.map(ip => ({ ...ip, available: true }));
        if (this.ctx.enableRegionMatching && workerRegion) {
            const sortedIPs = this.getSmartRegionSelection(workerRegion, availableIPs);
            if (sortedIPs.length > 0) return sortedIPs[0];
        }
        return availableIPs[0];
    }

    getSmartRegionSelection(workerRegion: string, availableIPs: any[]) {
        // ... (保持不变) ...
        if (!this.ctx.enableRegionMatching || !workerRegion) return availableIPs;
        const priorityRegions = Utils.getAllRegionsByPriority(workerRegion);
        const sortedIPs = [];
        for (const region of priorityRegions) {
            const regionIPs = availableIPs.filter(ip => ip.regionCode === region);
            sortedIPs.push(...regionIPs);
        }
        return sortedIPs;
    }

    _parseWsPacketHeader(chunk: any, token: string) {
        // ... (保持不变) ...
        if (chunk.byteLength < 24) return { hasError: true, message: ERRORS.E_INVALID_DATA };
        const version = new Uint8Array(chunk.slice(0, 1));
        if (Utils.formatIdentifier(new Uint8Array(chunk.slice(1, 17))) !== token) return { hasError: true, message: ERRORS.E_INVALID_USER };
        const optLen = new Uint8Array(chunk.slice(17, 18))[0];
        const cmd = new Uint8Array(chunk.slice(18 + optLen, 19 + optLen))[0];
        let isUDP = false;
        if (cmd === 1) { } else if (cmd === 2) { isUDP = true; } else { return { hasError: true, message: ERRORS.E_UNSUPPORTED_CMD }; }
        const portIdx = 19 + optLen;
        const port = new DataView(chunk.slice(portIdx, portIdx + 2).buffer).getUint16(0);
        let addrIdx = portIdx + 2, addrLen = 0, addrValIdx = addrIdx + 1, hostname = '';
        const addressType = new Uint8Array(chunk.slice(addrIdx, addrValIdx))[0];
        switch (addressType) {
            case ADDRESS_TYPE.IPV4: addrLen = 4; hostname = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + addrLen)).join('.'); break;
            case ADDRESS_TYPE.URL: addrLen = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + 1))[0]; addrValIdx += 1; hostname = new TextDecoder().decode(chunk.slice(addrValIdx, addrValIdx + addrLen)); break;
            case ADDRESS_TYPE.IPV6: addrLen = 16; const ipv6 = []; const ipv6View = new DataView(chunk.slice(addrValIdx, addrValIdx + addrLen).buffer); for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16)); hostname = ipv6.join(':'); break;
            default: return { hasError: true, message: `${ERRORS.E_INVALID_ADDR_TYPE}: ${addressType}` };
        }
        if (!hostname) return { hasError: true, message: `${ERRORS.E_EMPTY_ADDR}: ${addressType}` };
        return { hasError: false, addressType, port, hostname, isUDP, rawIndex: addrValIdx + addrLen, version };
    }

    _makeReadableStream(socket: WebSocket, earlyDataHeader: string) {
        // ... (保持不变) ...
        let cancelled = false;
        return new ReadableStream({
            type: "bytes",
            start: (controller) => {
                socket.addEventListener('message', (event) => { if (!cancelled) controller.enqueue(event.data); });
                socket.addEventListener('close', () => { if (!cancelled) { Utils.closeSocketQuietly(socket); controller.close(); } });
                socket.addEventListener('error', (err) => controller.error(err));
                const { earlyData, error } = Utils.base64ToArray(earlyDataHeader);
                if (error) controller.error(error); else if (earlyData) controller.enqueue(earlyData);
            },
            cancel: (_reason) => {
                cancelled = true;
                Utils.closeSocketQuietly(socket);
            }
        });
    }
}