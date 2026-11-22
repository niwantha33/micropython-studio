'use strict';

/**
 * Project-configured REPL port is authoritative. A VID:PID is not a unique USB
 * serial interface identity: REPL and debug CDC often report the same value.
 * Never "repair" an explicit port selection by choosing a different COM port.
 */
function isSavedUsbPort(port) {
    return typeof port === 'string' && port.trim() !== '' &&
        port.trim().toUpperCase() !== 'NOT_SET' &&
        !/^wss?:/i.test(port.trim());
}

function samePort(a, b) {
    return typeof a === 'string' && typeof b === 'string' &&
        a.trim().toLowerCase() === b.trim().toLowerCase();
}

function selectConfiguredPort(savedPort, connectedDevices) {
    const devices = Array.isArray(connectedDevices) ? connectedDevices : [];
    if (!isSavedUsbPort(savedPort)) return { port: null, present: false };
    const normalized = savedPort.trim();
    const live = devices.find(device => samePort(device.port, normalized));
    return { port: live ? live.port : normalized, present: Boolean(live) };
}

module.exports = { isSavedUsbPort, samePort, selectConfiguredPort };
