import { CF_BEST_DOMAINS, CONSTANTS } from "../core/Constants";
import { WorkerContext } from "../core/Context";
import { DomainRecord, DomainStorage, KVConfig } from "../types";
import { Utils } from "../Utils";

export class ConfigService {
    private ctx: WorkerContext;
    private readonly KV_KEY_CONFIG = 'c';
    private readonly KV_KEY_DOMAINs = 'domains';

    constructor(ctx: WorkerContext) {
        this.ctx = ctx;
    }

    async handleConfigRoute(): Promise<Response> {
        if (!this.checkKV()) return this.kvMissingResponse();

        const method = this.ctx.request.method.toUpperCase();
        if (method === 'GET') {
            const config = await this.getKVConfig();
            return Utils.jsonResponse({ ...config, kvEnabled: true });
        }
        if (method === 'POST') {
            try {
                const newConfig = await this.ctx.request.json() as KVConfig;
                const currentConfig = await this.getKVConfig();

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
        if (!this.checkKV()) return this.kvMissingResponse();

        const method = this.ctx.request.method.toUpperCase();
        if (method === 'GET') {
            const storage = await this.getDomainStorage();
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
                const storage = await this.getDomainStorage();

                // 检查重复
                const exists = [
                    ...storage.builtin, ...storage.custom
                ].some(d => d.domain === body.domain);
                if (exists) {
                    return Utils.errorResponse('域名已存在', 400);
                }

                const newDomain: DomainRecord = {
                    domain: body.domain,
                    name: body.name || body.domain,
                    port: body.port || 443,
                    enabled: true,
                    addedAt: new Date().toISOString(),
                    type: 'custom'
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
                const storage = await this.getDomainStorage();
                storage.custom = [];
                await this.saveDomainStorage(storage);
                return Utils.jsonResponse({ success: true, message: '已清空所有自定义域名' });
            }
            if (!body.domain) {
                return Utils.errorResponse('域名不能为空', 400);
            }
            const storage = await this.getDomainStorage();
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
            const storage = await this.getDomainStorage();
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
    async handleStatusRoute(): Promise<Response> {
        if (!this.checkKV()) return this.kvMissingResponse();
        const method = this.ctx.request.method.toUpperCase();
        if (method === 'GET') {
            const config = await this.getKVConfig();
            return Utils.jsonResponse({ region: this.ctx.region, echEnabled: config.ech });
        }
        return Utils.errorResponse('Unsupported method', 405);
    }
    private checkKV() {
        return this.ctx.kv !== null;
    }
    private kvMissingResponse() {
        return Utils.errorResponse('KV Namespace not bound', 503);
    }
    private async getKVConfig(): Promise<KVConfig> {
        if (!this.checkKV()) return {};
        try {
            const kvData = await this.ctx.kv!.get(this.KV_KEY_CONFIG);
            return kvData ? JSON.parse(kvData) as KVConfig : {};
        } catch (error) {
            console.error('Error fetching KV config:', error);
            return {};
        }
    }
    private async saveKVConfig(config: KVConfig): Promise<void> {
        if (!this.checkKV()) return;
        try {
            await this.ctx.kv!.put(this.KV_KEY_CONFIG, JSON.stringify(config));
        } catch (error) {
            console.error('Error saving KV config:', error);
        }
    }
    private async getDomainStorage(): Promise<DomainStorage> {
        if (!this.checkKV()) {
            return { builtin: [], custom: [] };
        }
        try {
            const kvData = await this.ctx.kv!.get(this.KV_KEY_DOMAINs);
            return kvData ? JSON.parse(kvData) as DomainStorage : { builtin: CF_BEST_DOMAINS.map(
                item => (
                    { domain: item.domain, name: item.name, enabled: true, type: 'builtin' } as DomainRecord
                )
            ), custom: [] };
        } catch (error) {
            console.error('Error fetching domain storage from KV:', error);
        }
        return {
            builtin: CF_BEST_DOMAINS.map(
                item => (
                    { domain: item.domain, name: item.name, enabled: true, type: 'builtin' } as DomainRecord
                )
            ), custom: []
        };
    }
    private async saveDomainStorage(storage: DomainStorage): Promise<void> {
        if (!this.checkKV()) return;
        try {
            await this.ctx.kv!.put(this.KV_KEY_DOMAINs, JSON.stringify(storage));
        } catch (error) {
            console.error('Error saving domain storage to KV:', error);
        }
    }
}