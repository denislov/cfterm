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
    [key: string]: any;
}

export interface DomainRecord {
    domain: string;
    name?: string;
    port?: number;
    enabled?: boolean;
    addedAt?: string;
    type? : 'builtin' | 'custom';
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