import { CONSTANTS } from "../core/Constants";
import { WorkerContext } from "../core/Context";
import { ChatService } from "../services/ChatService";
import { SubService } from "../services/SubService";
import { Utils } from "../Utils";
import { ApiHandler } from "./apiHandler";

export const router = async (ctx: WorkerContext, next: Function) => {
    const url = ctx.url;
    const path = url.pathname;

    // 1. WebSocket 路由
    if (ctx.request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const proxyService = new ChatService(ctx);
        return await proxyService.handleUpgrade();
    }

    // 2. 订阅请求处理
    if (path === '/sub') {
        const subService = new SubService(ctx);
        // 处理订阅请求的逻辑
        return await subService.handle();
    }

    // 3. API 路由处理
    if (path.startsWith('/api/')) {
        return ApiHandler.dispatch(ctx);
    }

    // 4. 默认html响应
    if (path === '/') {
        let redirectHtml = ''
        if (ctx.isAuth) {
            redirectHtml = CONSTANTS.INDEX_HTML_URL;
        } else {
            redirectHtml = CONSTANTS.TERM_HTML_URL;
        }
        try {
            const response = await fetch(redirectHtml, {
                headers: { 'User-Agent': 'Cloudflare-Worker/1.0' },
                cf: { cacheTtl: CONSTANTS.HTML_CACHE_TTL, cacheEverything: true }
            });

            if (response.ok) {
                let html = await response.text();
                return new Response(html, {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': `public, max-age=${CONSTANTS.HTML_CACHE_TTL}`
                    }
                });
            }
            throw new Error(`GitHub返回状态码: ${response.status}`);
        } catch (e) {
            return Utils.jsonResponse({
                error: 'HTML页面加载失败',
                message: (e as Error).message,
                hint: '请检查GitHub仓库配置是否正确',
                githubUrl: redirectHtml
            }, 503);
        }
    }
}