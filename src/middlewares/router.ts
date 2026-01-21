import { CONSTANTS } from "../core/Constants";
import { WorkerContext } from "../core/Context";
import { ProxyService } from "../services/ProxyService";
import { SubService } from "../services/SubService";
import { ApiHandler } from "./apiHandler";

export const router = async (ctx: WorkerContext, next: Function) => {
    const url = ctx.url;
    const path = url.pathname;

    // 1. WebSocket 路由
    if (ctx.request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const proxyService = new ProxyService(ctx);
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
        try {
            const response = await fetch(CONSTANTS.SUBSCRIPTION_HTML_URL, {
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
            return new Response(JSON.stringify({
                error: 'HTML页面加载失败',
                message: (e as Error).message,
                hint: '请检查GitHub仓库配置是否正确',
                githubUrl: CONSTANTS.SUBSCRIPTION_HTML_URL
            }), {
                status: 503,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }
}