import { connect } from "cloudflare:sockets";
import { BACKUP_IPS, ERRORS } from "../core/Constants";
import { WorkerContext } from "../core/Context";
import { ADDRESS_TYPE } from "../types";
import { Utils } from "../Utils";
import { VlessHeader, VlessParser } from "../protocols/VlessParser";

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

        const earlyDataHeader = this.ctx.request.headers.get(atob('c2VjLXdlYnNvY2tldC1wcm90b2NvbA==')) || '';

        this.handleStream(serverSock, earlyDataHeader)

        return new Response(null, {
            status: 101,
            webSocket: clientSock
        });
    }
    mergeUint8(left: Uint8Array, right: Uint8Array) {
        const out = new Uint8Array(left.length + right.length);
        out.set(left);
        out.set(right, left.length);
        return out;
    }
    private async handleStream(serverSock: WebSocket, earlyDataHeader: string) {
        let buffer = new Uint8Array(0);

        let vlessHeader: VlessHeader | null = null;
        let remoteSocket: Socket | null = null;
        // 1.创建WebSocket的readable
        const readable = this.makeReadableStream(serverSock,earlyDataHeader)
        // 解析vless数据头
        const reader = readable.getReader()
        while (true) {
            if (buffer.length >= 24) {
                const vlessResult = VlessParser.parseHeader(buffer.buffer, this.ctx.uuid)
                if (!vlessResult.hasError) {
                    vlessHeader = vlessResult
                    break
                }
                if (vlessResult.message !== ERRORS.E_INVALID_DATA) {
                    throw new Error(vlessResult.message)
                }
            }
            const { done, value } = await reader.read()
            if (done) return;
            if (value) {
                const chunkU8 = await Utils.toU8(value);
                buffer = this.mergeUint8(buffer, chunkU8);
            }
        }
        reader.releaseLock()

        // 解析成功，提取后面的数据
        const payload = buffer.subarray(vlessHeader!.rawIndex!)
        // 创建WebSocket的writable
        const respHeader = new Uint8Array([vlessHeader.version![0], 0]);
        // UDP 数据
        if (vlessHeader.isUDP) {
            console.info('isDNSQuery: ',vlessHeader?.isUDP)
            if (vlessHeader.port !== 53)
                throw new Error(ERRORS.E_UDP_DNS_ONLY);
            await this.handleUDP(payload, serverSock, respHeader);
        } else {
            serverSock.send(respHeader);
        }

        // 2.获取目标机或者是ProxyIP的 TCP Socket
        remoteSocket = await this.connectTarget(vlessHeader.addressType!, vlessHeader.hostname!, vlessHeader.port!)

        if (payload.length > 0) {
            const writer = remoteSocket?.writable.getWriter()
            await writer?.write(payload)
            writer?.releaseLock()
        }

        // 3.两者连接
        const closeSocket = () => { if (!earlyDataHeader) { remoteSocket?.close(), serverSock?.close() } };


        // WS -> TCP：每个 chunk 都写进去（包括第一次）
        Promise.all([readable.pipeTo(new WritableStream({
            write: async (chunk: any) => {
                const tcpWriter = remoteSocket.writable.getWriter();
                const u8 = await Utils.toU8(chunk);
                if (vlessHeader.isUDP) {
                    console.info('isDNSQuery: ',vlessHeader?.isUDP)
                    return this.handleUDP(u8, serverSock, null)
                }
                await tcpWriter.write(u8);
                tcpWriter.releaseLock()
            }
        })), this.manualPipe(remoteSocket.readable, serverSock)]).catch(() => { closeSocket();console.info("hello"); }).finally(() => { closeSocket();console.info("world"); });
    }
    bufferSize = 640 * 1024;
    safeBufferSize = this.bufferSize - 4096;
    flushTime = 2;
    async manualPipe(readable: ReadableStream, writable: WebSocket) {
        let buffer = new Uint8Array(this.bufferSize);
        let offset = 0;
        let timerId: number | null = null;
        let resume: (() => void) | null = null;
        const flushBuffer = () => {
            offset > 0 && (writable.send(buffer.slice(0, offset)), offset = 0);
            timerId && (clearTimeout(timerId), timerId = null), resume?.(), resume = null;
        };
        const reader = readable.getReader();
        try {
            while (true) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                if (chunk.length < 4096) {
                    flushBuffer();
                    writable.send(chunk);
                } else {
                    buffer.set(chunk, offset);
                    offset += chunk.length;
                    timerId || (timerId = setTimeout(flushBuffer, this.flushTime));
                    if (offset > this.safeBufferSize) await new Promise<void>(resolve => resume = resolve);
                }
            }
        } finally { flushBuffer(), reader.releaseLock() }
    }

    makeReadableStream(socket: WebSocket, earlyDataHeader: string) {
        let cancelled = false;
        console.info("===make:", socket)
        return new ReadableStream({
            start(controller) {
                socket.addEventListener('message', (event) => { if (!cancelled) controller.enqueue(event.data); });
                socket.addEventListener('close', () => { if (!cancelled) { controller?.close(); } });
                socket.addEventListener('error', (err) => {controller.error(err)});
                const { earlyData, error } = Utils.base64ToArray(earlyDataHeader);
                if (error) controller.error(error); else if (earlyData) controller.enqueue(earlyData);
            },
            cancel() { cancelled = true; Utils.closeSocketQuietly(socket); }
        });
    }
    private async connectTarget(addressType: ADDRESS_TYPE, hostname: string, port: number) {
        const tryConnect = async (h: string, p: number, useSocks: boolean) => {
            if (useSocks) {
                return await this.establishSocksConnection(addressType, h, p);
            }
            return connect({ hostname: h, port: p })
        };
        try {
            const useScoks = (this.ctx.kvConfig.enableSocksDowngrade && this.ctx.kvConfig.isSocksEnabled) ?? false;
            return await tryConnect(hostname, port, useScoks)
        } catch (error) {
            // 直连不行，尝试使用ProxyIP 或 出站ip
        }
        let backupHost = hostname;
        let backupPort = port;
        if (this.ctx.fallbackAddress?.trim()) {
            const parsed = Utils.parseAddressAndPort(this.ctx.fallbackAddress);
            backupHost = parsed.address;
            backupPort = parsed.port!;
        } else {
            const bestIP = await this.getBestBackupIP(this.ctx.region);
            if (bestIP) {
                backupHost = bestIP.domain;
                backupPort = bestIP.port;
            }
        }
        const fallbackUseSocks = (this.ctx.kvConfig.enableSocksDowngrade && this.ctx.kvConfig.isSocksEnabled) ?? false;
        return await tryConnect(backupHost, backupPort, fallbackUseSocks)
    }

    async handleUDP(udpChunk: any, webSocket: WebSocket, respHeader: Uint8Array<ArrayBuffer> | null) {
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

        if (this.ctx.kvConfig.enableRegionMatching && workerRegion) {
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

        if (!this.ctx.kvConfig.enableRegionMatching || !workerRegion) {
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