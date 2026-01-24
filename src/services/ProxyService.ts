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
        // console.info("开始处理 ws ")
        // 🛑 FIX 1: 安全获取 WebSocket 对象
        const wsPair = new WebSocketPair();
        const clientSock = wsPair[0];
        const serverSock = wsPair[1];

        serverSock.accept();

        let remoteConnWrapper: { socket: Socket | null } = { socket: null };
        let isDnsQuery = false;
        let protocolType: string | null = null;

        const earlyData = this.ctx.request.headers.get(atob('c2VjLXdlYnNvY2tldC1wcm90b2NvbA==')) || '';
        const readable = this.makeReadableStream(serverSock, earlyData);

        readable.pipeTo(new WritableStream({
            write: async (chunk) => {
                const u8chunk = await Utils.toU8(chunk)
                if (isDnsQuery) {
                    return await this.forwardUDP(u8chunk, serverSock, null);
                }
                if (remoteConnWrapper.socket) {
                    const writer = remoteConnWrapper.socket.writable.getWriter();
                    await writer.write(u8chunk);
                    writer.releaseLock();
                    return;
                }

                if (!protocolType) {
                    if (this.ctx.kvConfig.ev && u8chunk.byteLength >= 24) {
                        const vlessResult = this.parseWsPacketHeader(u8chunk, this.ctx.uuid);
                        if (!vlessResult.hasError) {
                            protocolType = 'vless';
                            const { addressType, port, hostname, rawIndex, version, isUDP } = vlessResult;
                            if (isUDP) {
                                if (port === 53) isDnsQuery = true;
                                else throw new Error(ERRORS.E_UDP_DNS_ONLY);
                            }
                            const respHeader = new Uint8Array([version![0], 0]);
                            const rawData = u8chunk.subarray(rawIndex);
                            if (isDnsQuery) return this.forwardUDP(rawData, serverSock, respHeader);
                            await this.forwardTCP(addressType!, hostname!, port!, rawData, serverSock, respHeader, remoteConnWrapper);
                            return;
                        }
                    }
                    throw new Error('Invalid protocol or authentication failed');
                }
            },
        })).catch((err) => { 
            console.error("出错了：",err.message)
        });

        return new Response(null, {
            status: 101,
            webSocket: clientSock
        });
    }

    async forwardTCP(addrType: ADDRESS_TYPE, host: string, portNum: number, rawData: any, ws: WebSocket, respHeader: Uint8Array<ArrayBuffer>, remoteConnWrapper: {
        socket: Socket | null;
    }) {

        const connectAndSend = async (address: string, port: number, useSocks = false) => {
            const remoteSock = useSocks ?
                await this.establishSocksConnection(addrType, address, port) :
                connect({ hostname: address, port: port });
            const writer = remoteSock.writable.getWriter();
            await writer.write(rawData);
            writer.releaseLock();
            return remoteSock;
        }

        const retryConnection = async () => {
            if (this.ctx.kvConfig.enableSocksDowngrade && this.ctx.kvConfig.isSocksEnabled) {
                try {
                    const socksSocket = await connectAndSend(host, portNum, true);
                    remoteConnWrapper.socket = socksSocket;
                    socksSocket.closed.catch(() => { }).finally(() => Utils.closeSocketQuietly(ws));
                    this.connectStreams(socksSocket, ws, respHeader, null);
                    return;
                } catch (socksErr) {
                    let backupHost, backupPort;
                    if (this.ctx.fallbackAddress && this.ctx.fallbackAddress.trim()) {
                        const parsed = Utils.parseAddressAndPort(this.ctx.fallbackAddress);
                        backupHost = parsed.address;
                        backupPort = parsed.port || portNum;
                    } else {
                        const bestBackupIP = await this.getBestBackupIP(this.ctx.region);
                        backupHost = bestBackupIP ? bestBackupIP.domain : host;
                        backupPort = bestBackupIP ? bestBackupIP.port : portNum;
                    }

                    try {
                        const fallbackSocket = await connectAndSend(backupHost, backupPort, false);
                        remoteConnWrapper.socket = fallbackSocket;
                        fallbackSocket.closed.catch(() => { }).finally(() => Utils.closeSocketQuietly(ws));
                        this.connectStreams(fallbackSocket, ws, respHeader, null);
                    } catch (fallbackErr) {
                        Utils.closeSocketQuietly(ws);
                    }
                }
            } else {
                let backupHost, backupPort;
                if (this.ctx.fallbackAddress && this.ctx.fallbackAddress.trim()) {
                    const parsed = Utils.parseAddressAndPort(this.ctx.fallbackAddress);
                    backupHost = parsed.address;
                    backupPort = parsed.port || portNum;
                } else {
                    const bestBackupIP = await this.getBestBackupIP(this.ctx.region);
                    backupHost = bestBackupIP ? bestBackupIP.domain : host;
                    backupPort = bestBackupIP ? bestBackupIP.port : portNum;
                }

                try {
                    const fallbackSocket = await connectAndSend(backupHost, backupPort, this.ctx.kvConfig.isSocksEnabled);
                    remoteConnWrapper.socket = fallbackSocket;
                    fallbackSocket.closed.catch(() => { }).finally(() => Utils.closeSocketQuietly(ws));
                    this.connectStreams(fallbackSocket, ws, respHeader, null);
                } catch (fallbackErr) {
                    Utils.closeSocketQuietly(ws);
                }
            }
        }

        try {
            const initialSocket = await connectAndSend(host, portNum, this.ctx.kvConfig.enableSocksDowngrade ? false : this.ctx.kvConfig.isSocksEnabled);
            remoteConnWrapper.socket = initialSocket;
            this.connectStreams(initialSocket, ws, respHeader, retryConnection);
        } catch (err) {
            retryConnection();
        }
    }

    parseWsPacketHeader(chunk: Uint8Array, token: string) {
        if (chunk.byteLength < 24) return { hasError: true, message: ERRORS.E_INVALID_DATA };
        const version = new Uint8Array(chunk.subarray(0, 1));
        if (Utils.formatIdentifier(new Uint8Array(chunk.subarray(1, 17))) !== token) return { hasError: true, message: ERRORS.E_INVALID_USER };
        const optLen = new Uint8Array(chunk.subarray(17, 18))[0];
        const cmd = new Uint8Array(chunk.subarray(18 + optLen, 19 + optLen))[0];
        let isUDP = false;
        if (cmd === 1) { } else if (cmd === 2) { isUDP = true; } else { return { hasError: true, message: ERRORS.E_UNSUPPORTED_CMD }; }
        const portIdx = 19 + optLen;
        const port = new DataView(chunk.slice(portIdx, portIdx + 2).buffer).getUint16(0);
        let addrIdx = portIdx + 2, addrLen = 0, addrValIdx = addrIdx + 1, hostname = '';
        const addressType = new Uint8Array(chunk.subarray(addrIdx, addrValIdx))[0];

        switch (addressType) {
            case ADDRESS_TYPE.IPV4: addrLen = 4; hostname = new Uint8Array(chunk.subarray(addrValIdx, addrValIdx + addrLen)).join('.'); break;
            case ADDRESS_TYPE.URL: addrLen = new Uint8Array(chunk.subarray(addrValIdx, addrValIdx + 1))[0]; addrValIdx += 1; hostname = new TextDecoder().decode(chunk.subarray(addrValIdx, addrValIdx + addrLen)); break;
            case ADDRESS_TYPE.IPV6: addrLen = 16; const ipv6 = []; const ipv6View = new DataView(chunk.slice(addrValIdx, addrValIdx + addrLen).buffer); for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16)); hostname = ipv6.join(':'); break;
            default: return { hasError: true, message: `${ERRORS.E_INVALID_ADDR_TYPE}: ${addressType}` };
        }
        if (!hostname) return { hasError: true, message: `${ERRORS.E_EMPTY_ADDR}: ${addressType}` };
        return { hasError: false, addressType, port, hostname, isUDP, rawIndex: addrValIdx + addrLen, version };
    }

    makeReadableStream(socket: WebSocket, earlyDataHeader: string) {
        let cancelled = false;
        return new ReadableStream({
            start(controller) {
                socket.addEventListener('message', (event) => { if (!cancelled) controller.enqueue(event.data); });
                socket.addEventListener('close', () => { if (!cancelled) { controller?.close(); } });
                socket.addEventListener('error', (err) => controller.error(err));
                const { earlyData, error } = Utils.base64ToArray(earlyDataHeader);
                if (error) controller.error(error); else if (earlyData) controller.enqueue(earlyData);
            },
            cancel() { cancelled = true; Utils.closeSocketQuietly(socket); }
        });
    }

    async connectStreams(remoteSocket: Socket, webSocket: WebSocket, headerData: Uint8Array<ArrayBuffer>, retryFunc: Function|null) {
        let header: Uint8Array<ArrayBuffer> | null = headerData, hasData = false;
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    hasData = true;
                    if (webSocket.readyState !== 1) controller.error(ERRORS.E_WS_NOT_OPEN);
                    if (header) { webSocket.send(await new Blob([header, chunk]).arrayBuffer()); header = null; }
                    else { webSocket.send(chunk); }
                },
                abort(reason) { },
            })
        ).catch((error) => { Utils.closeSocketQuietly(webSocket); });
        if (!hasData && retryFunc) retryFunc();
    }

    async forwardUDP(udpChunk: any, webSocket: WebSocket, respHeader: Uint8Array<ArrayBuffer>|null) {
        try {
            const tcpSocket = connect({ hostname: '8.8.4.4', port: 53 });
            let header = respHeader;
            const writer = tcpSocket.writable.getWriter();
            await writer.write(udpChunk);
            writer.releaseLock();
            await tcpSocket.readable.pipeTo(new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState === 1) {
                        if (header) { webSocket.send(await new Blob([header, chunk]).arrayBuffer()); header = null; }
                        else { webSocket.send(chunk); }
                    }
                },
            }));
        } catch (error) { }
    }

    async establishSocksConnection(addrType: ADDRESS_TYPE, address: string, port: number) {
        const { username, password, hostname, socksPort } = this.ctx.socksConfig!;
        const socket = connect({ hostname, port: socksPort });
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
        const encoder = new TextEncoder(); let DSTADDR;
        switch (addrType) {
            case ADDRESS_TYPE.IPV4: DSTADDR = new Uint8Array([1, ...address.split('.').map(Number)]); break;
            case ADDRESS_TYPE.URL: DSTADDR = new Uint8Array([3, address.length, ...encoder.encode(address)]); break;
            case ADDRESS_TYPE.IPV6: DSTADDR = new Uint8Array([4, ...address.split(':').flatMap(x => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)])]); break;
            default: throw new Error(ERRORS.E_INVALID_ADDR_TYPE);
        }
        await writer.write(new Uint8Array([5, 1, 0, ...DSTADDR, port >> 8, port & 255]));
        res = (await reader.read()).value;
        if (res[1] !== 0) throw new Error(ERRORS.E_SOCKS_CONN_FAIL);
        writer.releaseLock(); reader.releaseLock();
        return socket;
    }
    async getBestBackupIP(workerRegion = '') {

        if (BACKUP_IPS.length === 0) {
            return null;
        }

        const availableIPs = BACKUP_IPS.map(ip => ({ ...ip, available: true }));

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
    getSmartRegionSelection(workerRegion: string, availableIPs: {
        available: boolean;
        domain: string;
        region: string;
        regionCode: string;
        port: number;
    }[]) {

        if (!this.ctx.enableRegionMatching || !workerRegion) {
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
}