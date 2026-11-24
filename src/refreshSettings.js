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
const { resolveProjectCodeDir } = require('./deviceUploadPaths');

function getOutputChannel() {
    return require('./studioOutput').getStudioOutputChannel();
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
    } else if (preferredTransport !== 'webrepl') {
        // First-time USB setup only. Never override a saved Wi-Fi preference.
        // VID:PID alone cannot identify a REPL interface on a dual-CDC board.
        // Show every interface: selecting the lowest COM would silently pick
        // debugger CDC on some boards. User confirmation is required.
        const candidates = devicesRaw;
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

    const configuredCodeDir = await getConfigValue(configPath, 'filePath', 'deviceCodeDir');
    const deviceFirmware = await getConfigValue(configPath, 'device', 'device_firmware');
    // CircuitPython uses a real USB drive path. Never reinterpret E:\\ as
    // a MicroPython project main/ folder during source-path recovery.
    if (deviceFirmware === 'CircuitPython') {
        deviceCodeDir = configuredCodeDir;
    } else {
        deviceCodeDir = resolveProjectCodeDir(projectDir, configuredCodeDir);
        if (!deviceCodeDir) {
            vscode.window.showWarningMessage(
                'Cannot locate the project code directory. Check [filePath] deviceCodeDir in device.cfg and the local main/ folder before uploading.'
            );
            logMsg('[Upload Path] No existing source directory was found for this project.');
        } else if (configuredCodeDir && path.resolve(configuredCodeDir) !== path.resolve(deviceCodeDir)) {
            logMsg('[Upload Path] Saved deviceCodeDir does not match this project. Using current source: ' + deviceCodeDir);
        }
    }

    return [gRemoteDevicePort, deviceCodeDir, deviceFirmware || 'MicroPython', configPath];
}

module.exports = { getValidDevicePort, findProjectRoot };