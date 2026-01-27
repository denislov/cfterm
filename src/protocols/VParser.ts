import { ERRORS } from '../core/Constants';
import { ADDRESS_TYPE, ProtocolHeader } from '../types';
import { Utils } from '../Utils';

export class VParser {
	static parseHeader(chunk: Uint8Array, token: string): ProtocolHeader {
		if (chunk.byteLength < 24) return { hasError: true, message: ERRORS.E_INVALID_DATA };
		const version = new Uint8Array(chunk.subarray(0, 1));
		if (Utils.formatIdentifier(new Uint8Array(chunk.subarray(1, 17))) !== token) return { hasError: true, message: ERRORS.E_INVALID_USER };
		const optLen = new Uint8Array(chunk.subarray(17, 18))[0];
		const cmd = new Uint8Array(chunk.subarray(18 + optLen, 19 + optLen))[0];
		let isUDP = false;
		if (cmd === 1) {
		} else if (cmd === 2) {
			isUDP = true;
		} else {
			return { hasError: true, message: ERRORS.E_UNSUPPORTED_CMD };
		}
		const portIdx = 19 + optLen;
		const port = new DataView(chunk.slice(portIdx, portIdx + 2).buffer).getUint16(0);
		let addrIdx = portIdx + 2,
			addrLen = 0,
			addrValIdx = addrIdx + 1,
			hostname = '';
		const addressType = new Uint8Array(chunk.subarray(addrIdx, addrValIdx))[0];

		switch (addressType) {
			case ADDRESS_TYPE.IPV4:
				addrLen = 4;
				hostname = new Uint8Array(chunk.subarray(addrValIdx, addrValIdx + addrLen)).join('.');
				break;
			case ADDRESS_TYPE.URL:
				addrLen = new Uint8Array(chunk.subarray(addrValIdx, addrValIdx + 1))[0];
				addrValIdx += 1;
				hostname = new TextDecoder().decode(chunk.subarray(addrValIdx, addrValIdx + addrLen));
				break;
			case ADDRESS_TYPE.IPV6:
				addrLen = 16;
				const ipv6 = [];
				const ipv6View = new DataView(chunk.slice(addrValIdx, addrValIdx + addrLen).buffer);
				for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16));
				hostname = ipv6.join(':');
				break;
			default:
				return { hasError: true, message: `${ERRORS.E_INVALID_ADDR_TYPE}: ${addressType}` };
		}
		if (!hostname) return { hasError: true, message: `${ERRORS.E_EMPTY_ADDR}: ${addressType}` };
		return { hasError: false, addressType, port, hostname, isUDP, rawClientData: chunk.subarray(addrValIdx + addrLen), type: 'vless', version: version };
	}
}
