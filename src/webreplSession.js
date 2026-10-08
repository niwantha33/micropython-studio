'use strict';

/**
 * Runtime-only WebREPL setup. Never changes the board boot.py, the frozen
 * debugger, or Wi-Fi credentials. An already-connected WLAN is required.
 */
const OK = 'MPS_WEBREPL_OK|';
const ERROR = 'MPS_WEBREPL_ERROR|';

const STATUS = 'MPS_WEBREPL_STATUS|';

function buildWebReplStatusScript() {
    return [
        'try:',
        '    import network, webrepl',
        '    _mps_sta = network.WLAN(network.STA_IF)',
        '    if not _mps_sta.isconnected():',
        "        print('MPS_WEBREPL_ERROR|Board Wi-Fi is disconnected')",
        '    else:',
        '        _mps_ip = _mps_sta.ifconfig()[0]',
        '        if not hasattr(webrepl, "listen_s"):',
        "            print('MPS_WEBREPL_STATUS|UNKNOWN|' + _mps_ip)",
        '        elif webrepl.listen_s is None:',
        "            print('MPS_WEBREPL_STATUS|STOPPED|' + _mps_ip)",
        '        else:',
        "            print('MPS_WEBREPL_STATUS|RUNNING|' + _mps_ip)",
        'except Exception as _mps_err:',
        "    print('MPS_WEBREPL_ERROR|' + type(_mps_err).__name__ + ': ' + str(_mps_err))",
    ].join('\n');
}

function parseWebReplStatus(raw) {
    const lines = String(raw || '').split(/\r?\n/).map(s => s.trim());
    const err = lines.find(x => x.startsWith(ERROR));
    if (err) throw new Error(err.slice(ERROR.length).slice(0,260));
    const statusLine = lines.find(x => x.startsWith(STATUS));
    if (!statusLine) throw new Error('Board did not report WebREPL status over USB REPL.');
    const [, state, ip] = statusLine.split('|');
    if (!['RUNNING', 'STOPPED', 'UNKNOWN'].includes(state) ||
        !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip || '') ||
        ip.split('.').some(x => Number(x) > 255)) {
        throw new Error('Invalid WebREPL status from board.');
    }
    return { state, ip };
}

// The Dashboard may be connected over WebREPL even while the USB REPL
// remains open on COM8. Prefer the actual serial daemon, not the selected
// transport label, so WebREPL management can still work safely.
function resolveUsbReplPort(selectedPort, manager) {
    if (manager && manager.isConnected && !manager.isSuspended &&
        manager.portName && !String(manager.portName).startsWith('ws:')) {
        return manager.portName;
    }
    if (manager && manager.isConnected && manager.isSuspended) return null;
    if (typeof selectedPort === 'string' && selectedPort &&
        !selectedPort.startsWith('ws:')) return selectedPort;
    return null;
}

function buildSessionWebReplScript(password) {
    if (typeof password !== 'string' || password.length < 4 || password.length > 9) {
        throw new Error('WebREPL password must contain 4–9 characters.');
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

module.exports = { buildSessionWebReplScript, parseSessionWebReplResult, buildWebReplStatusScript, parseWebReplStatus, resolveUsbReplPort };
