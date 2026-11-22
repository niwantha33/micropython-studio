'use strict';

// The REPL and debugger may be separate CDC interfaces of the same board.
// Never infer that one is the other from VID:PID, COM ordering, or serial number.
const path = require('path');
const vscode = require('vscode');
const { getConnectedDevices } = require('./runCommand');
const { getConfigValue, updateCfgComponent } = require('./commonFxn');
const { findProjectRoot } = require('./refreshSettings');
const { isSavedUsbPort, samePort } = require('./devicePortSelection');

const DEBUG_SECTION = 'debug';
const DEBUG_PORT_KEY = 'adapter_port';

function validateDebugPort(value, replPort) {
    const port = typeof value === 'string' ? value.trim() : '';
    if (!isSavedUsbPort(port) || port.length > 256 ||
        /[\x00-\x1f\x7f]/.test(port) || /^tcp:/i.test(port)) {
        return 'Enter a dedicated serial debug adapter port (e.g. COM13 or /dev/ttyACM1).';
    }
    if (samePort(port, replPort)) {
        return 'This is the REPL/upload port. Select the OTHER, dedicated debug CDC port.';
    }
    return null;
}

/**
 * Only suggest (never auto-select) a possible second CDC when the same
 * physical board exposes two ports with a reliable, non-empty serial and
 * a matching VID:PID. Shared VID:PID alone is not sufficient evidence.
 */
function findPotentialDebugPorts(replPort, devices) {
    if (!Array.isArray(devices)) return [];
    const repl = devices.find(device => samePort(device?.port, replPort));
    if (!repl || !repl.serial || repl.serial === 'None' ||
        !repl.vidpid || repl.vidpid === '0000:0000') return [];
    return devices.filter(device => device && !samePort(device.port, replPort) &&
        !validateDebugPort(device.port, replPort) &&
        device.serial === repl.serial && device.vidpid === repl.vidpid);
}

async function findDebugConfigPath(folder) {
    const startDir = folder?.uri?.fsPath ||
        vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!startDir) return null;
    const root = await findProjectRoot(startDir);
    return root ? path.join(root, 'device.cfg') : null;
}

/**
 * Resolve a user-approved debugger CDC, recording it only in [debug] adapter_port.
 * A saved port is reused when present (or when enumeration is unavailable).
 * A missing saved port prompts the user; another COM port is never auto-selected.
 * options.devices/showQuickPick/showInputBox allow deterministic regression tests.
 */
async function chooseDebugAdapter(configPath, replPort, options = {}) {
    if (!configPath) throw new Error('Open a MicroPython project containing device.cfg first.');
    const replError = validateDebugPort(replPort, '');
    if (replError) throw new Error('Select a USB REPL/upload port before configuring debugging.');

    const saved = (await getConfigValue(configPath, DEBUG_SECTION, DEBUG_PORT_KEY) || '').trim();
    const requested = (options.requestedPort || '').trim();

    // Explicit launch.json configuration is an intentional choice. Persist it
    // so the Run button, legacy debugger, and next VS Code session agree.
    if (requested) {
        const error = validateDebugPort(requested, replPort);
        if (error) throw new Error(error);
        if (requested !== saved) {
            await updateCfgComponent(configPath, DEBUG_SECTION, DEBUG_PORT_KEY, requested);
        }
        return requested;
    }

    const devices = Array.isArray(options.devices)
        ? options.devices
        : await getConnectedDevices();
    const seen = new Set();
    const enumerated = Array.isArray(devices) ? devices : [];
    const detected = enumerated.filter(device => {
        const port = device && device.port;
        if (validateDebugPort(port, replPort)) return false;
        const key = port.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const savedValid = saved && !validateDebugPort(saved, replPort);
    const currentDevice = detected.find(device => samePort(device.port, saved));
    // A nonempty enumeration containing only REPL means the debugger is
    // absent, not that serial discovery failed. Ask instead of trusting it.
    if (savedValid && !options.force &&
        (enumerated.length === 0 || currentDevice)) {
        // A successful match may canonicalize 'com5' to 'COM5'. Never change
        // the actual port identity or replace an unavailable saved selection.
        const selected = currentDevice ? currentDevice.port.trim() : saved;
        if (selected !== saved) {
            await updateCfgComponent(configPath, DEBUG_SECTION, DEBUG_PORT_KEY, selected);
        }
        return selected;
    }

    const items = detected.map(device => ({
        label: '$(debug-alt) ' + device.port.trim(),
        description: savedValid && samePort(device.port, saved)
            ? 'Saved debugger port' : 'Detected serial port — confirm debugger CDC',
        detail: 'Separate from REPL ' + replPort + (device.vidpid ? '  |  USB ' + device.vidpid : ''),
        port: device.port.trim()
    }));
    if (savedValid && !currentDevice) {
        items.unshift({
            label: '$(warning) ' + saved,
            description: 'Previously saved — not currently detected',
            detail: 'Keep only if this is still your debugger CDC.',
            port: saved
        });
    }
    items.push({
        label: '$(edit) Enter adapter port manually…',
        description: 'COM port or /dev/tty…',
        manual: true
    });

    const showQuickPick = options.showQuickPick || vscode.window.showQuickPick;
    const showInputBox = options.showInputBox || vscode.window.showInputBox;
    const pick = await showQuickPick(items, {
        title: 'MicroPython Studio — Configure Debug Adapter',
        placeHolder: 'REPL ' + replPort + ' is reserved. Choose the separate debug CDC port.',
        ignoreFocusOut: true
    });
    if (!pick) return null; // Cancel: no change to device.cfg.

    let selected = pick.port;
    if (pick.manual) {
        selected = await showInputBox({
            title: 'Dedicated MicroPython Debug Adapter',
            prompt: 'Enter the debug CDC port (NOT the REPL port ' + replPort + ')',
            value: savedValid ? saved : '',
            placeHolder: process.platform === 'win32' ? 'COM13' : '/dev/ttyACM1',
            ignoreFocusOut: true,
            validateInput: value => validateDebugPort(value, replPort)
        });
    }
    if (!selected) return null;
    selected = selected.trim();
    const error = validateDebugPort(selected, replPort);
    if (error) throw new Error(error);
    if (selected !== saved) {
        await updateCfgComponent(configPath, DEBUG_SECTION, DEBUG_PORT_KEY, selected);
    }
    return selected;
}

module.exports = {
    chooseDebugAdapter, findDebugConfigPath, findPotentialDebugPorts, validateDebugPort,
    DEBUG_SECTION, DEBUG_PORT_KEY
};
