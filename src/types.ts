export enum ADDRESS_TYPE {
    IPV4 = 1,
    URL = 2,
    IPV6 = 3
}
export interface DomainItem {
    name: string;
    domain: string;
    port?: number;
    flag?: string;
}

export interface ProtocolHeader {
    hasError: boolean;
    type?: 'vless' | 'trojan' | 'xhttp';
    addressType?: ADDRESS_TYPE;
    hostname?: string;
    port?: number;
    rawClientData?: Uint8Array;
    message?: string;

    // for vless
    isUDP?: boolean;
    version?: Uint8Array;
}

export interface NodeInfo {
    ip: string;
    port: number;
    name: string;
    type: string;
    region?: string;
    user?: string;
    wsParams?: URLSearchParams;
    pathArgs?: string;
}

export interface ParsedRequest {
    addrType: ADDRESS_TYPE;
    hostname: string;
    port: number;
}

// 定义认证/代理参数结构
export interface AuthParams {
    username?: string;
    password?: string;
    hostname: string;
    port: number;
}

// 代理策略列表项结构
export interface StrategyItem {
    type: number;
    param?: string;
}

export type StrategyFn = (req: ParsedRequest, param: string) => Promise<Socket | null>;

export interface KVConfig {
    /**
     * === 核心协议开关 ===
     */
    // 是否启用 VLESS 协议 (SubService used)
    ev?: boolean;
    // 是否启用 Trojan 协议 (Constants defined, unused in code provided)
    et?: boolean;
    // 是否启用 XHTTP 协议 (SubService commented out)
    ex?: boolean;
    tp?: string;

    /**
     * === ECH (Encrypted Client Hello) 配置 ===
     * 用于绕过某些 SNI 阻断
     */
    ech?: boolean;

    // 自定义 DoH/DNS 地址 (e.g., 'https://dns.jhb.ovh/joeyblog')
    customDNS?: string;
    // 自定义 ECH 域名 (e.g., 'cloudflare-ech.com')
    customECHDomain?: string;
    wk?: string;
    // 重置标志
    reset?: boolean;
    xFallbackAddress?: string;

    // 为了兼容未在类型中定义的动态键值，保留索引签名
    [key: string]: any;
}

export interface DomainRecord {
    domain: string;
    name?: string;
    port?: number;
    enabled?: boolean;
    addedAt?: string;
    type?: 'builtin' | 'custom';
    backupArg?: string;
}

export interface DomainStorage {
    builtin: DomainRecord[];
    custom: DomainRecord[];
}