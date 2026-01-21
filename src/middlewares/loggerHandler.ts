import { WorkerContext } from "../core/Context";

export const loggerHandler = async (ctx: WorkerContext, next: Function) => {
    const start = Date.now();

    const resp = await next();

    const duration = Date.now() - start;

    console.log(`[${new Date().toISOString()}] ${ctx.request.method} ${ctx.url.pathname} - ${resp.status} - ${duration}ms`);
    
    resp.headers.set('X-Response-Time', `${duration}ms`);

    return resp;
}