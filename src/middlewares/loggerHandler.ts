import { WorkerContext } from "../core/Context";

export const loggerHandler = async (ctx: WorkerContext, next: Function) => {
	const start = Date.now();

	const resp = await next();

	const duration = Date.now() - start;

	console.info(`[${new Date().toISOString()}] ${ctx.request.method} ${ctx.url.pathname} - ${resp.status} - ${duration}ms`);
	
	if (resp.status !== 101) {
        // 添加ECH状态到响应头
        if (ctx.echConfig){
            resp.headers.set('X-ECH-Status', "ENABLED");
            resp.headers.set('X-ECH-Config-Length', String(ctx.echConfig.length));
        }
        resp.headers.set('X-Worker-Region', ctx.region);
        resp.headers.set('X-Response-Time', `${duration}ms`)
    };

	return resp;
};