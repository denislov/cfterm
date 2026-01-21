import { WorkerContext } from "../core/Context";

/**
 * CORS 头配置
 */
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token',
    'Access-Control-Max-Age': '86400',
};

/**
 * CORS 中间件
 * 处理预检请求 (OPTIONS) 并为所有响应添加 CORS 头
 */
export const corsHandler = async (ctx: WorkerContext, next: () => Promise<Response>): Promise<Response> => {
    // 处理预检请求
    if (ctx.request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders
        });
    }

    // 继续处理请求
    const response = await next();

    // 为响应添加 CORS 头
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
    });

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
};
