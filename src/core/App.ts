import { WorkerContext } from './Context';

/**
 * 中间件函数类型定义
 * next: 调用链中的下一个中间件
 */
export type Middleware = (ctx: WorkerContext, next: () => Promise<Response>) => Promise<Response | void>;

export class WorkerApp {
    private middlewares: Middleware[];

    constructor() {
        this.middlewares = [];
    }

    /**
     * 注册中间件
     * 顺序很重要：先注册的先执行（洋葱的最外层）
     */
    public use(middleware: Middleware): this {
        this.middlewares.push(middleware);
        return this;
    }

    /**
     * 核心调度入口
     * 在 index.ts 中被 fetch 方法调用
     */
    public async dispatch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
        // 1. 初始化上下文 (Context)
        // 这个 Context 实例将在所有中间件中传递
        const ctx = new WorkerContext(request, env, execution);

        // 2. 组合所有中间件为一个执行函数
        const composedMiddleware = this.compose(this.middlewares);

        try {
            // 3. 开始执行
            // 初始的 next 函数返回一个 404，作为洋葱的最核心（如果没有中间件处理请求）
            const response = await composedMiddleware(ctx, async () => {
                return new Response('Route Not Found', { status: 404 });
            });

            // 确保始终返回一个 Response 对象
            return response || new Response('Internal Server Error: No response generated', { status: 500 });
        } catch (err: any) {
            // 4. 兜底错误捕获
            // 理论上应该由 ErrorHandler 中间件捕获，这里是最后的防线
            console.error('Fatal Error in App Dispatch:', err);
            return new Response(JSON.stringify({
                error: 'Critical Worker Error',
                message: err.message
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    /**
     * 组合中间件 (Koa-style Compose)
     * 递归地将中间件串联起来
     */
    private compose(middleware: Middleware[]): (ctx: WorkerContext, next: () => Promise<Response>) => Promise<Response> {
        return function (context: WorkerContext, next: () => Promise<Response>) {
            // index 用于防止在一个中间件中多次调用 next()
            let index = -1;
            
            return dispatch(0);

            function dispatch(i: number): Promise<Response> {
                if (i <= index) {
                    return Promise.reject(new Error('next() called multiple times'));
                }
                
                index = i;
                let fn = middleware[i];
                
                // 如果已经执行完所有中间件，则执行传入的 next (即上面的 404 逻辑)
                if (i === middleware.length) {
                    fn = next; // 类型断言适配
                }
                
                if (!fn) {
                    return Promise.resolve(new Response('Middleware Chain Ended Unexpectedly', { status: 500 }));
                }

                try {
                    // 执行当前中间件：fn(ctx, nextMiddleware)
                    // 使用 dispatch.bind 递归绑定下一个索引
                    const result = fn(context, dispatch.bind(null, i + 1));
                    return Promise.resolve(result as unknown as Response);
                } catch (err) {
                    return Promise.reject(err);
                }
            }
        };
    }
}