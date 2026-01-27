import { ADDRESS_TYPE } from "../types";
import { Utils } from "../Utils";

export interface THeader {
    hasError: boolean;
    addressType?: ADDRESS_TYPE;
    port?: number;
    hostname?: string;
    rawClientData?: Uint8Array;
    message?: string;
}

export class TParser {
    static async parseTrojanHeader(buffer: Uint8Array, ut: string): Promise<THeader> {

        const passwordToHash = ut;
        const sha224Password = await Utils.sha224(passwordToHash);

        if (buffer.byteLength < 56) {
            return {
                hasError: true,
                message: "invalid " + atob('dHJvamFu') + " data - too short"
            };
        }
        let crLfIndex = 56;
        if (new Uint8Array(buffer.slice(56, 57))[0] !== 0x0d || new Uint8Array(buffer.slice(57, 58))[0] !== 0x0a) {
            return {
                hasError: true,
                message: "invalid " + atob('dHJvamFu') + " header format (missing CR LF)"
            };
        }
        const password = new TextDecoder().decode(buffer.slice(0, crLfIndex));
        if (password !== sha224Password) {
            return {
                hasError: true,
                message: "invalid " + atob('dHJvamFu') + " password"
            };
        }

        const socks5DataBuffer = buffer.slice(crLfIndex + 2);
        if (socks5DataBuffer.byteLength < 6) {
            return {
                hasError: true,
                message: atob('aW52YWxpZCBTT0NLUzUgcmVxdWVzdCBkYXRh')
            };
        }

        const view = new DataView(socks5DataBuffer.buffer);
        const cmd = view.getUint8(0);
        if (cmd !== 1) {
            return {
                hasError: true,
                message: "unsupported command, only TCP (CONNECT) is allowed"
            };
        }

        const atype = view.getUint8(1);
        let addressLength = 0;
        let addressIndex = 2;
        let address = "";
        let addressType: ADDRESS_TYPE;
        switch (atype) {
            case 1:
                addressLength = 4;
                addressType = ADDRESS_TYPE.IPV4;
                address = new Uint8Array(
                    socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)
                ).join(".");
                break;
            case 3:
                addressLength = new Uint8Array(
                    socks5DataBuffer.slice(addressIndex, addressIndex + 1)
                )[0];
                addressIndex += 1;
                addressType = ADDRESS_TYPE.URL;
                address = new TextDecoder().decode(
                    socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)
                );
                break;
            case 4:
                addressLength = 16;
                addressType = ADDRESS_TYPE.IPV6;
                const dataView = new DataView(socks5DataBuffer.buffer.slice(addressIndex, addressIndex + addressLength));
                const ipv6 = [];
                for (let i = 0; i < 8; i++) {
                    ipv6.push(dataView.getUint16(i * 2).toString(16));
                }
                address = ipv6.join(":");
                break;
            default:
                return {
                    hasError: true,
                    message: `invalid addressType is ${atype}`
                };
        }

        if (!address) {
            return {
                hasError: true,
                message: `address is empty, addressType is ${atype}`
            };
        }

        const portIndex = addressIndex + addressLength;
        const portBuffer = socks5DataBuffer.slice(portIndex, portIndex + 2);
        const portRemote = new DataView(portBuffer.buffer).getUint16(0);

        return {
            hasError: false,
            addressType: addressType,
            port: portRemote,
            hostname: address,
            rawClientData: socks5DataBuffer.slice(portIndex + 4)
        };
    }
}