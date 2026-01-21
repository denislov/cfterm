import { WorkerContext } from "../core/Context";
import { Utils } from "../Utils";

export const errorHandler = async (ctx: WorkerContext, next: Function) => {
    try {
        return await next();
    } catch (err) {
        console.error('Crash:', err);
        return Utils.jsonResponse({
            success: false,
            error: (err as Error).message || 'Internal Server Error',
            stack: ctx.env.DEBUG_MODE ? (err as Error).stack : undefined
        }, 500);
    }
};