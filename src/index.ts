import { WorkerApp } from "./core/App";
import { authHandler, errorHandler, loggerHandler, corsHandler } from "./middlewares";
import { router } from "./middlewares/router";

const app = new WorkerApp()
app.use(errorHandler);
// app.use(corsHandler); // 注释，不然会导致ws握手失败
app.use(loggerHandler);
app.use(authHandler)
app.use(router);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return app.dispatch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
