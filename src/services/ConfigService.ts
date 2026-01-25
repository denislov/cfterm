import { CONSTANTS } from "../core/Constants";
import { WorkerContext } from "../core/Context";
import { DomainRecord, DomainStorage, KVConfig } from "../types";
import { Utils } from "../Utils";

export class ConfigService {
    private ctx: WorkerContext;
    private readonly KV_KEY_CONFIG = 'c';
    private readonly KV_KEY_DOMAIN = 'domains';

    constructor(ctx: WorkerContext) {
        this.ctx = ctx;
    }

    async handleConfigRoute(): Promise<Response> {
        if (!this.ctx.kv) return this.kvMissingResponse();

        const method = this.ctx.request.method.toUpperCase();
        if (method === 'GET') {
            const config = this.ctx.kvConfig;
            console.info(config)
            return Utils.jsonResponse({ ...config, kvEnabled: true });
        }
        if (method === 'POST') {
            try {
                const newConfig = await this.ctx.request.json() as KVConfig;
                if (newConfig.reset) {
                    await this.saveKVConfig({
                        ...CONSTANTS.KV_CONFIG_DEFAULTS
                    })
                    return Utils.jsonResponse({ success: true, message: '配置已保存', config: CONSTANTS.KV_CONFIG_DEFAULTS });
                }
                const currentConfig = this.ctx.kvConfig;

                for (const [key, value] of Object.entries(newConfig)) {
                    if (value === '' || value === null || value === undefined) {
                        delete currentConfig[key];
                    } else {
                        currentConfig[key] = value;
                    }
                }
                await this.saveKVConfig(currentConfig);
                return Utils.jsonResponse({ success: true, message: '配置已保存', config: currentConfig });

            } catch (error) {
                return Utils.errorResponse('保存配置失败: ' + (error as Error).message, 400);
            }
        }

        return Utils.errorResponse('Unsupported method', 405);
    }
    // 处理 /api/domains 路由
    async handleDomainsRoute(): Promise<Response> {
        if (!this.ctx.kv) return this.kvMissingResponse();

        const method = this.ctx.request.method.toUpperCase();
        if (method === 'GET') {
            const storage = this.ctx.kvDomain;
            return Utils.jsonResponse({ success: true, ...storage, total: storage.builtin.length + storage.custom.length });
        }
        if (method === 'POST') {
            try {
                const body = await this.ctx.request.json() as Partial<DomainRecord>;
                if (!body.domain) {
                    return Utils.errorResponse('域名不能为空', 400);
                }
                if (!Utils.isDomain(body.domain) && !Utils.isIp(body.domain)) {
                    return Utils.errorResponse('无效的域名或IP地址', 400);
                }
                const storage = this.ctx.kvDomain;

                // 检查重复
                const exists = [
                    ...storage.builtin, ...storage.custom
                ].some(d => d.name === body.name);
                if (exists) {
                    return Utils.errorResponse('域名已存在', 400);
                }

                const newDomain: DomainRecord = {
                    domain: body.domain,
                    name: body.name || body.domain,
                    port: body.port || 443,
                    enabled: true,
                    addedAt: new Date().toISOString(),
                    type: 'custom',
                    backupArg: body.backupArg
                };
                storage.custom.push(newDomain);
                await this.saveDomainStorage(storage);
                return Utils.jsonResponse({ success: true, message: '添加成功', data: newDomain });
            } catch (error) {
                return Utils.errorResponse('保存域名列表失败' + (error as Error).message, 400);
            }
        }
        if (method === 'DELETE') {
            const body = await this.ctx.request.json() as { domain?: string, type?: string, all?: boolean };

            // 清空所有
            if (body.all) {
                const storage = this.ctx.kvDomain;
                storage.custom = [];
                await this.saveDomainStorage(storage);
                return Utils.jsonResponse({ success: true, message: '已清空所有自定义域名' });
            }
            if (!body.domain) {
                return Utils.errorResponse('域名不能为空', 400);
            }
            const storage = this.ctx.kvDomain;
            const customIdx = storage.custom.findIndex(d => d.domain === body.domain);
            const builtinIdx = storage.builtin.findIndex(d => d.domain === body.domain);
            if (customIdx >= 0) {
                storage.custom.splice(customIdx, 1);
            } else if (builtinIdx >= 0 && body.type === 'builtin') {
                // 内置域名使用禁用标志处理
                storage.builtin[builtinIdx].enabled = false;
            } else {
                return Utils.errorResponse('域名不存在', 404);
            }
            await this.saveDomainStorage(storage);
            return Utils.jsonResponse({ success: true, message: '域名已删除' });
        }
        if (method === 'PUT') {
            const body = await this.ctx.request.json() as Partial<DomainRecord>;
            if (!body.domain) {
                return Utils.errorResponse('域名不能为空', 400);
            }
            const storage = this.ctx.kvDomain;
            let found = false;
            // 优先查找内置
            const builtin = storage.builtin.find(d => d.domain === body.domain);
            if (builtin) {
                if (body.enabled !== undefined) {
                    builtin.enabled = body.enabled;
                }
                if (body.name !== undefined) {
                    builtin.name = body.name;
                }
                found = true;
            }
            const custom = storage.custom.find(d => d.domain === body.domain);
            if (custom) {
                if (body.enabled !== undefined) {
                    custom.enabled = body.enabled;
                }
                if (body.name !== undefined) {
                    custom.name = body.name;
                }
                if (body.port !== undefined) {
                    custom.port = body.port;
                }
                found = true;
            }
            if (!found) {
                return Utils.errorResponse('域名不存在', 404);
            }
            await this.saveDomainStorage(storage);
            return Utils.jsonResponse({ success: true, message: '域名已更新' });
        }

        return Utils.errorResponse('Unsupported method', 405);
    }

    private kvMissingResponse() {
        return Utils.errorResponse('KV Namespace not bound', 503);
    }

    private async saveKVConfig(config: KVConfig): Promise<void> {
        if (!this.ctx.kv) return;
        try {
            await this.ctx.kv!.put(this.KV_KEY_CONFIG, JSON.stringify(config));
        } catch (error) {
            console.error('Error saving KV config:', error);
        }
    }

    private async saveDomainStorage(storage: DomainStorage): Promise<void> {
        if (!this.ctx.kv) return;
        try {
            await this.ctx.kv!.put(this.KV_KEY_DOMAIN, JSON.stringify(storage));
        } catch (error) {
            console.error('Error saving domain storage to KV:', error);
        }
    }
}