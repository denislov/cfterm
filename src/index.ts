import { WorkerApp } from "./core/App";
import { authHandler, errorHandler, loggerHandler, protocolHandler } from "./middlewares";
import { router } from "./middlewares/router";

const app = new WorkerApp()
app.use(errorHandler);
app.use(loggerHandler);
app.use(protocolHandler);  // 协议层处理（WebSocket, XHTTP）- 有自己的认证机制
app.use(authHandler);       // 常规 HTTP 请求认证
app.use(router);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return app.dispatch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
