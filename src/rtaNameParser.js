'use strict';

// Optional backward-compatible firmware text replies:
//   rta_name=200344d0:get_gpio_state
// The function pointer is a runtime VM object address, NOT a linker-map symbol.
const RTA_NAME_REPLY = /^rta_name=([0-9a-fA-F]{8}):([^\r\n]{1,72})$/;

function parseRtaNameReply(text) {
    if (typeof text !== 'string') return null;
    const m = RTA_NAME_REPLY.exec(text);
    if (!m) return null;
    const fun = Number.parseInt(m[1], 16);
    const name = m[2].trim();
    if (fun === 0 || !name || /[\x00-\x1f\x7f]/.test(name)) return null;
    return { fun, name };
}

module.exports = { parseRtaNameReply };
