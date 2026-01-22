import { WorkerContext } from "../core/Context";
import { Utils } from "../Utils";

export const authHandler = async (ctx: WorkerContext, next: () => Promise<Response>): Promise<Response> => {
    const path = ctx.url.pathname;

    // WebSocket连接不需要认证，直接通过
    if (ctx.request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return next();
    }

    // 从 Header 中获取 token (支持 X-Token 或 Authorization: Bearer xxx)
    const xToken = ctx.request.headers.get('X-Token');
    const authHeader = ctx.request.headers.get('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // 也支持从 URL 查询参数获取 token（用于页面跳转场景）
    const urlToken = ctx.url.searchParams.get('token');

    const token = xToken || bearerToken || urlToken;

    // 验证 token
    if (token && Utils.isUuid(token) && token === ctx.uuid) {
        ctx.isAuth = true;
    }
    // 公开路由，不需要鉴权
    if (path === '/' || path === '/api/status') {
        return next();
    } else if (!ctx.isAuth) {
        return Utils.jsonResponse({ error: 'Unauthorized: Invalid token' }, 403);
    }

    // 继续处理下一个中间件或请求处理程序
    return next();
};