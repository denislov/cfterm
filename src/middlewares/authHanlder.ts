import { WorkerContext } from "../core/Context";
import { Utils } from "../Utils";

export const authHandler = async (ctx: WorkerContext, next: () => Promise<Response>): Promise<Response> => {
    const path = ctx.url.pathname;

    // 公开路由，不需要鉴权
    if (path === '/' || path === '/api/status') {
        return next();
    }

    // 从 Header 中获取 token (支持 X-Token 或 Authorization: Bearer xxx)
    const xToken = ctx.request.headers.get('X-Token');
    const authHeader = ctx.request.headers.get('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const token = xToken || bearerToken;

    // 验证 token
    if (!token) {
        return Utils.jsonResponse({ error: 'Unauthorized: Missing token' }, 401);
    }

    if (!Utils.isUuid(token) || token !== ctx.uuid) {
        return Utils.jsonResponse({ error: 'Unauthorized: Invalid token' }, 403);
    }

    // 继续处理下一个中间件或请求处理程序
    return next();
};