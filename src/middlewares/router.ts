import { CONSTANTS } from '../core/Constants';
import { WorkerContext } from '../core/Context';
import { ChatService } from '../services/ChatService';
import { SubService } from '../services/SubService';
import { Utils } from '../Utils';
import { ApiHandler } from './apiHandler';

export const router = async (ctx: WorkerContext, next: Function) => {
	const url = ctx.url;
	const path = url.pathname;

	// 1. WebSocket 路由
	if (ctx.request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
		const chatService = new ChatService(ctx);
		return await chatService.handleUpgrade();
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
		if (!ctx.isAuth) {
			return new Response('DeepSeek inference engine is running.', {
				status: 200,
				headers: {
					'Content-Type': 'text/plain; charset=UTF-8',
				},
			});
		}
		try {
			return ctx.env.ASSETS.fetch(ctx.request);
			const response = await fetch(CONSTANTS.INDEX_HTML_URL, {
				headers: { 'User-Agent': 'Cloudflare-Worker/1.0' },
				cf: { cacheTtl: CONSTANTS.HTML_CACHE_TTL, cacheEverything: true },
			});

			if (response.ok) {
				let html = await response.text();
				return new Response(html, {
					status: 200,
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': `public, max-age=${CONSTANTS.HTML_CACHE_TTL}`,
					},
				});
			}
			throw new Error(`GitHub返回状态码: ${response.status}`);
		} catch (e) {
			return Utils.jsonResponse(
				{
					error: 'HTML页面加载失败',
					message: (e as Error).message,
					hint: '请检查GitHub仓库配置是否正确',
					githubUrl: CONSTANTS.INDEX_HTML_URL,
				},
				503,
			);
		}
	}
	if (url.pathname === '/v1/models') {
		const data = {
			object: 'list',
			data: [
				{ id: 'DeepSeek-V3.2-Exp', object: 'model', created: 1710000000, owned_by: 'deepseek' },
				{ id: 'DeepSeek-V3.1-Terminus', object: 'model', created: 1710000500, owned_by: 'deepseek' },
				{ id: 'DeepSeek-Ocr', object: 'model', created: 1710001000, owned_by: 'deepseek' },
			],
		};
		return new Response(JSON.stringify(data), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}
};
