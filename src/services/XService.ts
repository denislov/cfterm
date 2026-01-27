import { connect } from "cloudflare:sockets";
import { WorkerContext } from "../core/Context";
import { ADDRESS_TYPE } from "../types";
import { Utils } from "../Utils";


interface XHeader {
    hostname?: string;
    port?: number;
    data?: Uint8Array<ArrayBuffer>;
    resp?: Uint8Array<ArrayBuffer>;
    reader?: ReadableStreamBYOBReader;
    done?: boolean;
    message?: string;
    hasError: boolean;
}

class XhttpCounter {
    #total: number;

    constructor() {
        this.#total = 0;
    }

    get() {
        return this.#total;
    }

    add(size: number) {
        this.#total += size;
    }
}

export class XService {
    ctx: WorkerContext;
    ACTIVE_CONNECTIONS = 0;
    XHTTP_BUFFER_SIZE = 128 * 1024;
    CONNECT_TIMEOUT_MS = 5000;
    IDLE_TIMEOUT_MS = 45000;
    MAX_RETRIES = 2;
    MAX_CONCURRENT = 32;
    textEncoder = new TextEncoder();
    constructor(ctx: WorkerContext) {
        this.ctx = ctx;
    }
    async handle() {
        try {
            return await this.handle_xhttp_client(this.ctx.request.body, this.ctx.uuid);
        } catch (err) {
            return null;
        }
    }
    async handle_xhttp_client(body: ReadableStream<any> | null, uuid: string) {
        if (this.ACTIVE_CONNECTIONS >= this.MAX_CONCURRENT) {
            return new Response('Too many connections', { status: 429 });
        }

        this.ACTIVE_CONNECTIONS++;

        let cleaned = false;
        const cleanup = () => {
            if (!cleaned) {
                this.ACTIVE_CONNECTIONS = Math.max(0, this.ACTIVE_CONNECTIONS - 1);
                cleaned = true;
            }
        };

        // 使用 AbortController 统一管理连接生命周期
        const abortController = new AbortController();
        const signal = abortController.signal;

        try {
            const httpx = await this.read_xhttp_header(body!, uuid);
            if (typeof httpx !== 'object' || !httpx) {
                cleanup();
                return null;
            }

            const bestBackupIP = Utils.getBestBackupIP(this.ctx);
            const fallbackAddress = bestBackupIP ? bestBackupIP.domain : '';

            const remoteConnection = await this.connect_to_remote_xhttp(httpx, fallbackAddress, '13.230.34.30');
            if (remoteConnection === null) {
                cleanup();
                return null;
            }

            const uploader = this.create_xhttp_uploader(httpx, remoteConnection.writable, signal);
            const downloader = this.create_xhttp_downloader(httpx.resp!, remoteConnection.readable, signal);

            // 等待连接完成或超时
            // 注意：uploader 错误通常是正常的连接关闭，不应导致整体失败
            const connectionClosed = (async () => {
                try {
                    // uploader 完成（无论成功还是失败）和 downloader 完成都是正常的
                    // 只有 downloader 错误才需要关注
                    const uploaderPromise = uploader.done.catch((err: Error) => {
                        // uploader 错误通常是 "Network connection lost"，这是正常的连接关闭
                    });

                    const downloaderPromise = downloader.done.catch((err: Error) => {
                        console.log('[XHTTP] Downloader finished with error:', err?.message || err);
                        throw err; // 只有 downloader 错误才抛出
                    });

                    const timeoutPromise = this.xhttp_sleep(this.IDLE_TIMEOUT_MS).then(() => {
                        throw new Error('idle timeout');
                    });

                    // 等待 downloader 完成（或超时），uploader 在后台运行
                    await Promise.race([downloaderPromise, timeoutPromise]);

                    // downloader 完成后，给 uploader 一点时间完成
                    await Promise.race([uploaderPromise, this.xhttp_sleep(1000)]);

                } catch (err) {
                    // 只有 downloader 错误或超时才会到这里
                    console.log('[XHTTP] Connection error:', (err as Error)?.message || err);
                } finally {
                    // 确保清理
                    if (!signal.aborted) {
                        abortController.abort();
                    }
                    try { remoteConnection.close(); } catch (_) { }
                    cleanup();
                }
            })();

            return {
                readable: downloader.readable,
                closed: connectionClosed
            };
        } catch (error) {
            abortController.abort();
            cleanup();
            return null;
        }
    }

    async read_xhttp_header(readable: ReadableStream<any>, uuid_str: string): Promise<XHeader> {
        const reader = readable.getReader({ mode: 'byob' });

        try {
            let r = await reader.readAtLeast(1 + 16 + 1, this.get_xhttp_buffer());
            let rlen = 0;
            let idx = 0;
            let cache = r.value!;
            rlen += r!.value!.length;

            const version = cache[0];
            const id = cache.slice(1, 1 + 16);
            const uuid = this.parse_uuid_xhttp(uuid_str);

            if (!this.validate_uuid_xhttp(id, uuid)) {
                return { hasError: true, message: 'invalid UUID' };
            }
            const pb_len = cache[1 + 16];
            const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1;

            if (addr_plus1 + 1 > rlen) {
                if (r.done) {
                    return { hasError: true, message: 'header too short' };
                }
                idx = addr_plus1 + 1 - rlen;
                r = await reader.readAtLeast(idx, this.get_xhttp_buffer());
                rlen += r!.value!.length;
                cache = this.concat_typed_arrays(cache, r!.value!);
            }

            const cmd = cache[1 + 16 + 1 + pb_len];
            if (cmd !== 1) {
                return { hasError: true, message: `unsupported command: ${cmd}` };
            }
            const port = (cache[addr_plus1 - 1 - 2] << 8) + cache[addr_plus1 - 1 - 1];
            const atype = cache[addr_plus1 - 1];
            let header_len = -1;
            if (atype === ADDRESS_TYPE.IPV4) {
                header_len = addr_plus1 + 4;
            } else if (atype === ADDRESS_TYPE.IPV6) {
                header_len = addr_plus1 + 16;
            } else if (atype === ADDRESS_TYPE.URL) {
                header_len = addr_plus1 + 1 + cache[addr_plus1];
            }

            if (header_len < 0) {
                return { hasError: true, message: 'read address type failed' };
            }

            idx = header_len - rlen;
            if (idx > 0) {
                if (r.done) {
                    return { hasError: true, message: `read address failed` };
                }
                r = await reader.readAtLeast(idx, this.get_xhttp_buffer());
                rlen += r!.value!.length;
                cache = this.concat_typed_arrays(cache, r!.value!);
            }

            let hostname = '';
            idx = addr_plus1;
            switch (atype) {
                case ADDRESS_TYPE.IPV4:
                    hostname = cache.slice(idx, idx + 4).join('.');
                    break;
                case ADDRESS_TYPE.URL:
                    hostname = new TextDecoder().decode(
                        cache.slice(idx + 1, idx + 1 + cache[idx]),
                    );
                    break;
                case ADDRESS_TYPE.IPV6:
                    hostname = cache
                        .slice(idx, idx + 16)
                        .reduce<string[]>(
                            (s, b2, i2, a) =>
                                i2 % 2
                                    ? s.concat(((a[i2 - 1] << 8) + b2).toString(16))
                                    : s,
                            [],
                        )
                        .join(':');
                    break;
            }

            if (hostname.length < 1) {
                return { hasError: true, message: 'failed to parse hostname' };
            }

            const data = cache.slice(header_len);
            return {
                hasError: false,
                hostname,
                port,
                data,
                resp: new Uint8Array([version, 0]),
                reader,
                done: r.done,
            };
        } catch (error) {
            try { reader.releaseLock(); } catch (_) { }
            throw error;
        }
    }

    async connect_to_remote_xhttp(httpx: XHeader, ...remotes: string[]) {
        let attempt = 0;
        let lastErr;

        const connectionList = [httpx.hostname, ...remotes.filter(r => r && r !== httpx.hostname)];
        for (const hostname of connectionList) {
            if (!hostname) continue;

            attempt = 0;
            while (attempt < this.MAX_RETRIES) {
                attempt++;
                try {
                    const remote = connect({ hostname, port: httpx.port! });
                    const timeoutPromise = this.xhttp_sleep(this.CONNECT_TIMEOUT_MS).then(() => {
                        throw new Error(atob('Y29ubmVjdCB0aW1lb3V0'));
                    });

                    await Promise.race([remote.opened, timeoutPromise]);

                    return {
                        readable: remote.readable,
                        writable: remote.writable,
                        close: () => {
                            try { remote.close(); } catch (_) { }
                        }
                    };
                } catch (err) {
                    lastErr = err;
                    if (attempt < this.MAX_RETRIES) {
                        await this.xhttp_sleep(500 * attempt);
                    }
                }
            }
        }

        return null;
    }
    xhttp_sleep(ms?: number) {
        return new Promise((r) => setTimeout(r, ms));
    }
    get_xhttp_buffer(size?: number) {
        return new Uint8Array(new ArrayBuffer(size || this.XHTTP_BUFFER_SIZE));
    }
    parse_uuid_xhttp(uuid: string) {
        uuid = uuid.replaceAll('-', '');
        const r = [];
        for (let index = 0; index < 16; index++) {
            const v = parseInt(uuid.substr(index * 2, 2), 16);
            r.push(v);
        }
        return r;
    }
    validate_uuid_xhttp(id: Uint8Array, uuid: number[]) {
        for (let index = 0; index < 16; index++) {
            if (id[index] !== uuid[index]) {
                return false;
            }
        }
        return true;
    }
    concat_typed_arrays(first: Uint8Array, ...args: Uint8Array[]) {
        let len = first.length;
        for (let a of args) {
            len += a.length;
        }
        const r = new Uint8Array(len);
        r.set(first, 0);
        len = first.length;
        for (let a of args) {
            r.set(a, len);
            len += a.length;
        }
        return r;
    }

    create_xhttp_uploader(httpx: any, writable: WritableStream, signal: AbortSignal) {
        const counter = new XhttpCounter();
        const writer = writable.getWriter();

        const done = (async () => {
            try {
                await this.upload_to_remote_xhttp(counter, writer, httpx, signal);
            } catch (error) {
                // 忽略由于 abort 导致的错误
                if (signal.aborted) {
                    console.log('[XHTTP] Uploader: aborted');
                    return;
                }
                throw error;
            } finally {
                try {
                    await writer.close();
                } catch (error) {
                    // 忽略关闭错误
                }
            }
        })();

        return {
            counter,
            done,
            abort: () => {
                try { writer.abort(); } catch (_) { }
            }
        };
    }

    create_xhttp_downloader(resp: Uint8Array, remote_readable: ReadableStream, signal: AbortSignal) {
        const counter = new XhttpCounter();
        let stream!: TransformStream;
        let resolvePromise: (value?: void) => void;
        let rejectPromise: (reason?: any) => void;

        const done = new Promise<void>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;

            stream = new TransformStream(
                {
                    start(controller) {
                        counter.add(resp.length);
                        controller.enqueue(resp);
                    },
                    transform(chunk, controller) {
                        counter.add(chunk.length);
                        controller.enqueue(chunk);
                    },
                    cancel(reason) {
                        reject(`download cancelled: ${reason}`);
                    },
                },
                undefined,
                new ByteLengthQueuingStrategy({ highWaterMark: this.XHTTP_BUFFER_SIZE }),
            );

            // 监听 abort 信号
            signal.addEventListener('abort', () => {
                try { stream.writable.abort?.('aborted'); } catch (_) { }
                try { stream.readable.cancel?.('aborted'); } catch (_) { }
            }, { once: true });

            const reader = remote_readable.getReader();
            const writer = stream.writable.getWriter();

            (async () => {
                let idleTimer: ReturnType<typeof setInterval> | null = null;
                try {
                    let chunkCount = 0;
                    let lastActivity = Date.now();

                    idleTimer = setInterval(() => {
                        if (Date.now() - lastActivity > this.IDLE_TIMEOUT_MS) {
                            if (idleTimer) clearInterval(idleTimer);
                            rejectPromise('idle timeout');
                        }
                    }, 5000);

                    while (!signal.aborted) {
                        const r = await reader.read();
                        if (r.done) {
                            break;
                        }
                        chunkCount++;
                        lastActivity = Date.now();
                        await writer.write(r.value);
                        if (chunkCount % 5 === 0) {
                            await this.xhttp_sleep(0);
                        }
                    }
                    resolvePromise();
                } catch (err) {
                    if (!signal.aborted) {
                        console.log('[XHTTP] Downloader: error', err);
                        rejectPromise(err);
                    } else {
                        resolvePromise(); // aborted, resolve normally
                    }
                } finally {
                    if (idleTimer) clearInterval(idleTimer);
                    try { reader.releaseLock(); } catch (_) { }
                    try { writer.releaseLock(); } catch (_) { }
                }
            })();
        });

        return {
            readable: stream.readable,
            counter,
            done,
            abort: () => {
                try { stream.readable.cancel(); } catch (_) { }
                try { stream.writable.abort(); } catch (_) { }
            }
        };
    }

    async upload_to_remote_xhttp(counter: XhttpCounter, writer: WritableStreamDefaultWriter, httpx: XHeader, signal: AbortSignal) {
        async function inner_upload(d: Uint8Array) {
            if (!d || d.length === 0) {
                return;
            }
            counter.add(d.length);
            await writer.write(d);
        }

        try {
            await inner_upload(httpx.data!);

            let chunkCount = 0;
            while (!httpx.done && !signal.aborted) {
                try {
                    const r = await httpx.reader!.read(this.get_xhttp_buffer());

                    if (r.done) {
                        httpx.done = true;
                        break;
                    }
                    if (r.value) {
                        if (r.value.length >= 5) {
                            const sub = r.value.subarray(0, 5);
                            if (sub && sub.length === 5 &&
                                sub.every((val, idx) => val === [23, 3, 3, 0, 19][idx])) {
                                httpx.done = true;
                                break;
                            }
                        }
                    }
                    chunkCount++;
                    await inner_upload(r.value);

                    if (chunkCount % 10 === 0) {
                        await this.xhttp_sleep(0);
                    }
                    if (!r.value || r.value.length === 0) {
                        await this.xhttp_sleep(2);
                    }
                } catch (readError: any) {
                    // 读取错误可能是客户端断开连接（正常情况）
                    const errorMessage = readError?.message || String(readError);

                    // "Network connection lost" 是正常的连接关闭信号
                    if (errorMessage.includes('Network connection lost') ||
                        errorMessage.includes('connection') ||
                        signal.aborted) {
                        httpx.done = true;
                        break;
                    }
                    throw readError;
                }
            }
        } catch (error) {
            console.log('[XHTTP] Uploader: error', error);
            throw error;
        }
    }
}