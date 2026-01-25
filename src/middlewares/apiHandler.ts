import { WorkerContext } from '../core/Context';
import { ConfigService } from '../services/ConfigService';

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
		if (path === '/api/status') {
			return new Response('DeepSeek inference engine is running.', {
				status: 200,
				headers: {
					'Content-Type': 'text/plain; charset=UTF-8',
				},
			});
		}

		return new Response('API 路径未找到', { status: 404 });
	}
}
