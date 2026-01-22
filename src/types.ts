export enum ADDRESS_TYPE {
    IPV4 = 1,
    URL = 2,
    IPV6 = 3
}
export interface DomainItem {
    name: string;
    domain: string;
    port?: number;
}
export interface NodeInfo {
    ip: string;
    port: number;
    name: string;
    type: 'vless' | 'trojan' | 'xhttp';
    region?: string;
}
export interface ProtocolHeader {
    hasError: boolean;
    message?: string;
    addressType: ADDRESS_TYPE;
    address?: string;
    port?: number;
    version?: Uint8Array;
    isUDP?: boolean;
    rawHeaderLength?: number;
}

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

    /**
     * === 网络与 IP 偏好 ===
     */
    // 是否启用 IPv4
    ipv4?: boolean;
    // 是否启用 IPv6
    ipv6?: boolean;
    // 优选 IP - 移动
    ispMobile?: boolean;
    // 优选 IP - 联通
    ispUnicom?: boolean;
    // 优选 IP - 电信
    ispTelecom?: boolean;

    /**
     * === ECH (Encrypted Client Hello) 配置 ===
     * 用于绕过某些 SNI 阻断
     */
    // ECH 总开关
    enableECH?: boolean;
    // 简写开关 (Constants defined)
    ech?: boolean;
    // 自定义 DoH/DNS 地址 (e.g., 'https://dns.jhb.ovh/joeyblog')
    customDNS?: string;
    // 自定义 ECH 域名 (e.g., 'cloudflare-ech.com')
    customECHDomain?: string;
    // ECH 配置字符串 (通常由后端生成或手动填入)
    echConfig?: string;

    /**
     * === SOCKS5 代理/回退配置 ===
     */
    // 是否启用 SOCKS5 作为出站代理
    isSocksEnabled?: boolean;
    // 连接失败时是否降级/回退到 SOCKS5
    enableSocksDowngrade?: boolean;

    /**
     * === 其他/未明确用途的标志位 (来自 CONSTANTS) ===
     */
    // 建议保留默认值，具体含义可能涉及前端或旧版逻辑
    epd?: boolean;
    epi?: boolean;
    egi?: boolean;
    dkby?: boolean;
    ae?: boolean;

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
}

export interface DomainStorage {
    builtin: DomainRecord[];
    custom: DomainRecord[];
}

export interface SSConfig {
    hostname: string;
    socksPort: number;
    username?: string;
    password?: string;
}