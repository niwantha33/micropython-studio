'use strict';

const vscode = require('vscode');
const { getConnectedDevices } = require('./runCommand');
const { normalizeSerialPort, samePort, isSavedUsbPort } = require('./devicePortSelection');

/**
 * List all physical serial adapters. VID:PID and COM ordering do not prove
 * which USB CDC interface is the REPL or the native debugger.
 */
function buildSerialAdapterItems(devices, selected, excludePort = '') {
    const items = [];
    const seen = new Set();
    for (const device of Array.isArray(devices) ? devices : []) {
        const port = normalizeSerialPort(device.port);
        if (!port || !isSavedUsbPort(port) || samePort(port, excludePort)) continue;
        const key = process.platform === 'win32' ? port.toLowerCase() : port;
        if (seen.has(key)) continue;
        seen.add(key);
        const vidpid = typeof device.vidpid === 'string' ? device.vidpid : '';
        const serial = typeof device.serial === 'string' ? device.serial : '';
        items.push({
            label: '$(plug) USB Serial Adapter (' + port + ')',
            description: samePort(port, selected) ? 'Currently selected' : (vidpid || ''),
            detail: serial && serial !== 'None' ? 'USB serial: ' + serial : '',
            port
        });
    }
    if (isSavedUsbPort(selected) && !samePort(selected, excludePort) &&
        !items.some(item => samePort(item.port, selected))) {
        const port = normalizeSerialPort(selected);
        items.unshift({
            label: '$(plug) Saved adapter (' + port + ')',
            description: 'Not currently detected',
            detail: 'Choose only when this is the correct port for your board',
            port
        });
    }
    return items;
}

function validateManualPort(value) {
    const port = normalizeSerialPort(value);
    if (/^COM[1-9]\d*$/i.test(port)) return null;
    if (/^\/dev\/(?:tty[A-Za-z0-9._-]+|cu\.[A-Za-z0-9._-]+)$/.test(port)) return null;
    return 'Enter a serial device such as COM5, /dev/ttyACM0, or /dev/cu.usbmodem101.';
}

/** Show connected adapters with COM numbers, then return the user's choice. */
async function pickSerialAdapter({ selected = '', excludePort = '', purpose = 'REPL' } = {}) {
    const devices = await getConnectedDevices();
    const options = buildSerialAdapterItems(devices, selected, excludePort);
    options.push({
        label: '$(edit) Enter serial port manually…',
        description: 'Use when your adapter is not detected',
        manual: true
    });
    const choice = await vscode.window.showQuickPick(options, {
        title: 'MicroPython Studio — Select ' + purpose + ' adapter',
        placeHolder: 'Choose the ' + purpose + ' USB serial interface (COM port)',
        ignoreFocusOut: true
    });
    if (!choice) return null;
    let port = choice.port;
    if (choice.manual) {
        const entered = await vscode.window.showInputBox({
            title: 'Enter ' + purpose + ' serial port',
            prompt: 'Windows COM ports are displayed as COM5, COM13, etc.',
            value: isSavedUsbPort(selected) ? normalizeSerialPort(selected) : '',
            ignoreFocusOut: true,
            validateInput: validateManualPort
        });
        if (entered === undefined) return null;
        port = normalizeSerialPort(entered);
    }
    if (!port || !isSavedUsbPort(port) || samePort(port, excludePort)) {
        throw new Error('Select a ' + purpose + ' port different from ' +
            (excludePort || 'the current device') + '.');
    }
    return normalizeSerialPort(port);
}

module.exports = { buildSerialAdapterItems, validateManualPort, pickSerialAdapter };
