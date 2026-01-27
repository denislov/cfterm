import { WorkerContext } from '../core/Context';
import { ChatService } from '../services/ChatService';
import { XService } from '../services/XService';

/**
 * 协议层处理中间件
 * 处理 WebSocket 和 XHTTP 等特殊协议请求
 * 这些请求有自己的认证机制（UUID路径匹配），不需要经过常规的 token 认证
 */
export const protocolHandler = async (ctx: WorkerContext, next: () => Promise<Response>): Promise<Response> => {
    const path = ctx.url.pathname;

    // 1. WebSocket 升级请求 - 使用 vless 协议自带的 UUID 验证
    if (ctx.request.headers.get('Upgrade')?.toLowerCase() === atob('d2Vic29ja2V0')) {
        const chatService = new ChatService(ctx);
        return await chatService.handleUpgrade();
    }

    // 2. XHTTP 请求 - 通过路径中的 UUID 进行验证
    // 路径格式: /{uuid}/0, /{uuid}/1, etc.
    if (ctx.request.method === 'POST' && !ctx.kvConfig.ex) {
        if (path.startsWith('/' + ctx.uuid.substring(0, 8))) {
            return await handleXhttp(ctx);
        }

    }

    // 非协议请求，继续下一个中间件
    return next();
};

/**
 * 处理 XHTTP 代理请求
 */
async function handleXhttp(ctx: WorkerContext): Promise<Response> {
    const xService = new XService(ctx);
    const r = await xService.handle();

    if (r) {
        if (r instanceof Response) {
            return r;
        }
        ctx.executionCtx.waitUntil(r.closed);
        return new Response(r.readable, {
            headers: {
                'X-Accel-Buffering': 'no',
                'Cache-Control': 'no-store',
                Connection: 'keep-alive',
                'User-Agent': 'Go-http-client/2.0',
                'Content-Type': 'application/grpc',
            },
        });
    }

    return new Response('Bad Gateway', { status: 502 });
}
