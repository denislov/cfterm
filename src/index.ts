/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { WorkerApp } from "./core/App";
import { authHandler, errorHandler, loggerHandler, corsHandler } from "./middlewares";
import { router } from "./middlewares/router";

const app = new WorkerApp()
app.use(errorHandler);
app.use(corsHandler);
app.use(loggerHandler);
app.use(authHandler)
app.use(router);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return app.dispatch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
