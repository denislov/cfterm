import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { ProxyService } from '../src/services/ProxyService';
import { WorkerContext } from '../src/core/Context';

describe('VLESS Connection Tests', () => {
    it('should parse VLESS packet header correctly', async () => {
        // 创建一个模拟的请求和上下文
        const mockRequest = new Request('https://example.com', {
            headers: {
                'Upgrade': 'websocket',
                'Sec-WebSocket-Protocol': 'binary'
            }
        });
        
        const mockEnv = {
            u: '351c9981-04b6-4103-aa4b-864aa9c91469',
            C: null,
            DEBUG_MODE: 'false'
        } as unknown as Env;
        
        const mockCtx = createExecutionContext();
        const context = new WorkerContext(mockRequest, mockEnv, mockCtx);
        await context.loadKVConfig();
        
        const proxyService = new ProxyService(context);
        
        // 测试UUID验证
        expect(context.uuid).toBe('351c9981-04b6-4103-aa4b-864aa9c91469');
        expect(context.kvConfig.ev).toBe(true);
    });
});