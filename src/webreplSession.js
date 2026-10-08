'use strict';

/**
 * Runtime-only WebREPL setup. Never changes the board boot.py, the frozen
 * debugger, or Wi-Fi credentials. An already-connected WLAN is required.
 */
const OK = 'MPS_WEBREPL_OK|';
const ERROR = 'MPS_WEBREPL_ERROR|';

function buildSessionWebReplScript(password) {
    if (typeof password !== 'string' || password.length < 4 || password.length > 64) {
        throw new Error('WebREPL password must contain 4–64 characters.');
    }
    // JSON string syntax is valid for ordinary Python unicode string literals.
    return [
        'import network',
        'try:',
        '    import webrepl',
        '    _mps_wlan = network.WLAN(network.STA_IF)',
        '    if not _mps_wlan.isconnected():',
        "        print('MPS_WEBREPL_ERROR|Wi-Fi is not connected on the board')",
        '    else:',
        '        webrepl.start(password=' + JSON.stringify(password) + ')',
        "        print('MPS_WEBREPL_OK|' + _mps_wlan.ifconfig()[0])",
        'except Exception as _mps_err:',
        "    print('MPS_WEBREPL_ERROR|' + type(_mps_err).__name__ + ': ' + str(_mps_err))",
    ].join('\n');
}

function parseSessionWebReplResult(raw) {
    const lines = String(raw || '').split(/\r?\n/).map(s => s.trim());
    const failure = lines.find(s => s.startsWith(ERROR));
    if (failure) throw new Error(failure.slice(ERROR.length).slice(0, 260));
    const success = lines.find(s => s.startsWith(OK));
    if (!success) throw new Error('WebREPL did not confirm startup. Check the connected REPL COM port and Output log.');
    const ip = success.slice(OK.length);
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ||
        ip.split('.').some(part => Number(part) > 255)) {
        throw new Error('WebREPL returned an invalid IPv4 address.');
    }
    return ip;
}

module.exports = { buildSessionWebReplScript, parseSessionWebReplResult };
