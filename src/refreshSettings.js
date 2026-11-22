/**
 * refreshSettings.js
 * Device detection and port configuration refresh
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const net = require('net');
const { getConnectedDevices } = require('./runCommand');
const { getDeviceSecret } = require('./deviceSecrets');
const { getConfigValue, updateCfgComponent, redactDevicePort } = require('./commonFxn');
const { selectConfiguredPort, isSavedUsbPort } = require('./devicePortSelection');

let outputChannel = null;

function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('MicroPython IDE');
    }
    return outputChannel;
}

/**
 * Test whether a WebREPL device is reachable on port 8266.
 * @param {string} ip
 * @returns {Promise<boolean>}
 */
function checkWebReplReachable(ip) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(2000);
        sock.connect(8266, ip, () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
    });
}

/**
 * Search upward from startDir to find a directory containing 'device.cfg'.
 * Stops at the filesystem root or workspace boundary.
 *
 * @param {string} startDir - Directory to start searching from
 * @returns {Promise<string|null>} Path to the directory containing device.cfg, or null
 */
async function findProjectRoot(startDir) {
    let current = startDir;

    // Walk up the directory tree looking for device.cfg
    while (true) {
        const cfgPath = path.join(current, 'device.cfg');
        try {
            await fs.access(cfgPath);
            return current; // Found it!
        } catch {
            // Not in this directory, go up
        }

        const parent = path.dirname(current);
        if (parent === current) {
            // Reached filesystem root
            return null;
        }
        current = parent;
    }
}

/**
 * Suggest a first-time REPL port when a physical device exposes multiple CDC ports.
 * IMPORTANT: the lowest COM number is only a heuristic. Never use this filter
 * to override an explicitly saved project port or infer the debugger interface.
 * @param {Array<{port: string, serial: string, vidpid: string}>} devices
 * @returns {Array<{port: string, serial: string, vidpid: string}>}
 */
function filterDualCdcPorts(devices) {
    const groups = new Map();
    for (const d of devices) {
        const ser = (d.serial || '').trim().toLowerCase();
        if (ser && ser !== 'none') {
            if (!groups.has(ser)) {
                groups.set(ser, []);
            }
            groups.get(ser).push(d);
        }
    }

    const secondaryPorts = new Set();
    
    // Helper to compare ports numerically (COM4 vs COM10) or lexicographically
    const comparePorts = (a, b) => {
        const numA = parseInt((a.match(/\d+/) || [])[0], 10);
        const numB = parseInt((b.match(/\d+/) || [])[0], 10);
        if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
        }
        return a.localeCompare(b);
    };

    for (const [ser, groupDevices] of groups.entries()) {
        if (groupDevices.length > 1) {
            // Sort ports of the same physical device in ascending order
            groupDevices.sort((a, b) => comparePorts(a.port, b.port));
            
            // The first one is primary (REPL), all others are secondary (debug/RTA)
            const logStr = `[Port Detection] Multiple CDC ports for serial ${ser}: suggested initial USB port ${groupDevices[0].port}, additional ports ${groupDevices.slice(1).map(x => x.port).join(', ')} (manual selection takes priority)`;
            console.log(logStr);
            try {
                getOutputChannel().appendLine(logStr);
            } catch (_) {}

            for (let i = 1; i < groupDevices.length; i++) {
                secondaryPorts.add(groupDevices[i].port);
            }
        }
    }

    return devices.filter(d => !secondaryPorts.has(d.port));
}

/**
 * Detect the valid device port for the current project.
 * Reads the project's device.cfg and matches against connected devices.
 *
 * @param {vscode.Uri} [resource] - Optional folder URI (from explorer context menu)
 * @returns {Promise<[string|null, string|null, string, string|null]>} [devicePort, deviceCodeDir, deviceFirmware, exactConfigPath]
 */
async function getValidDevicePort(resource) {
    let gRemoteDevicePort = null;
    let deviceCodeDir = null;

    // Determine starting directory — from context menu or workspace root
    let startDir = null;
    if (resource && resource.fsPath) {
        startDir = resource.fsPath;
    } else {
        // Fallback to workspace root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            startDir = workspaceFolders[0].uri.fsPath;
        } else {
            vscode.window.showWarningMessage('No workspace folder open. Please open a MicroPython project first.');
            return [null, null, 'MicroPython', null];
        }
    }

    // Search upward for device.cfg
    const projectDir = await findProjectRoot(startDir);
    if (!projectDir) {
        vscode.window.showWarningMessage(
            'No device.cfg found. Please create a project first or run from the project root folder.'
        );
        return [null, null, 'MicroPython', null];
    }

    const configPath = path.join(projectDir, 'device.cfg');

    const savedPort = await getConfigValue(configPath, 'device', 'port');
    const devId = await getConfigValue(configPath, 'device', 'deviceId');
    const preferredTransport = await getConfigValue(configPath, 'device', 'run_transport');

    const devicesRaw = await getConnectedDevices();
    const logMsg = (message) => {
        console.log(message);
        try { getOutputChannel().appendLine(message); } catch (_) {}
    };
    // Manual port selection is authoritative. In particular, the REPL CDC
    // port can have exactly the same VID:PID and serial number as debug CDC.
    // A refresh must not change [device] port based on VID:PID or COM ordering.
    const preferred = selectConfiguredPort(savedPort, devicesRaw);
    if (preferred.port) {
        gRemoteDevicePort = preferred.port;
        if (preferred.present) {
            logMsg(`[Port Detection] Using configured port ${redactDevicePort(preferred.port)} from ${configPath}`);
        } else {
            logMsg(`[Port Detection] Configured port ${redactDevicePort(preferred.port)} is not currently detected; preserving device.cfg without changes.`);
            vscode.window.showWarningMessage(
                `Configured port ${redactDevicePort(preferred.port)} is unavailable. It will not be automatically replaced. Select another port manually if the COM number changed.`
            );
        }
    } else {
        // First-time setup only. Never guess that a matching VID:PID uniquely
        // identifies the REPL interface, because dual-CDC devices share it.
        const candidates = filterDualCdcPorts(devicesRaw);
        if (candidates.length === 0) {
            logMsg('[Port Detection] No connected USB devices detected for initial selection.');
        }
        for (const device of candidates) {
            if (!device.port || device.vidpid === '0000:0000') continue;
            const matchingId = devId && devId !== 'undefined' && device.vidpid === devId;
            const answer = await vscode.window.showInformationMessage(
                `Select ${device.port} as the MicroPython REPL port${matchingId ? ' (saved device ID matches)' : ''}? Confirm this is the REPL USB interface, not the debugger interface.`,
                'Use This Port', 'Next', 'Cancel'
            );
            if (answer === 'Use This Port') {
                await updateCfgComponent(configPath, 'device', 'port', device.port);
                await updateCfgComponent(configPath, 'device', 'deviceId', device.vidpid);
                gRemoteDevicePort = device.port;
                break;
            }
            if (!answer || answer === 'Cancel') break;
        }
    }

    // Respect the explicitly selected transport across refresh as well.
    // USB [device] port stays saved separately and never stores Wi-Fi secrets.
    const preferWifi = preferredTransport === 'webrepl';
    if (preferWifi || !gRemoteDevicePort) {
        const enabled = await getConfigValue(configPath, 'remote', 'webrepl_enabled');
        const ip = await getConfigValue(configPath, 'remote', 'webrepl_ip');
        const password = await getDeviceSecret(configPath, 'webrepl_password');
        if (enabled === 'true' && ip && password && await checkWebReplReachable(ip)) {
            gRemoteDevicePort = `ws:${ip},${password}`;
            logMsg('[Port Detection] Using configured WebREPL transport ' + ip);
        } else if (preferWifi) {
            // Do not silently select USB when the user explicitly chose Wi-Fi.
            gRemoteDevicePort = null;
            vscode.window.showWarningMessage(
                'Saved WebREPL transport is unavailable. Select USB or repair the Wi-Fi connection.'
            );
        }
    }

    // Never convert NOT_SET or an unavailable explicit selection to a guessed COM.
    if (!preferWifi && !gRemoteDevicePort && isSavedUsbPort(savedPort)) {
        gRemoteDevicePort = savedPort.trim();
    }

    deviceCodeDir = await getConfigValue(configPath, 'filePath', 'deviceCodeDir');
    const deviceFirmware = await getConfigValue(configPath, 'device', 'device_firmware');

    return [gRemoteDevicePort, deviceCodeDir, deviceFirmware || 'MicroPython', configPath];
}

module.exports = { getValidDevicePort, findProjectRoot };