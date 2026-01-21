import { WorkerContext } from "../core/Context";
import { ConfigService } from "../services/ConfigService";

export class ApiHandler {
    static async dispatch(ctx: WorkerContext) {
        const path = ctx.url.pathname;
        const service = new ConfigService(ctx);

        if (path === '/api/config') {
            return await service.handleConfigRoute();
        }
        if (path === '/api/domains') {
            return await service.handleDomainsRoute();
        }

        return new Response('API 路径未找到', { status: 404 });
    }
}