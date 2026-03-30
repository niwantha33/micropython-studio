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
const { getConfigValue, updateCfgComponent } = require('./commonFxn');

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
 * @returns {Promise<[string|null, string|null, string]>} [devicePort, deviceCodeDir, deviceFirmware]
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
            return [null, null, 'MicroPython'];
        }
    }

    // Search upward for device.cfg
    const projectDir = await findProjectRoot(startDir);
    if (!projectDir) {
        vscode.window.showWarningMessage(
            'No device.cfg found. Please create a project first or run from the project root folder.'
        );
        return [null, null, 'MicroPython'];
    }

    const configPath = path.join(projectDir, 'device.cfg');

    const savedPort = await getConfigValue(configPath, 'device', 'port');
    const devId = await getConfigValue(configPath, 'device', 'deviceId');

    const devices = await getConnectedDevices();
    console.log('Connected devices:', devices);

    if (devices.length > 0) {
        for (const device of devices) {
            const devicePort = device.port;
            const vidpid = device.vidpid;

            if (devId && devId !== 'undefined' && devId === vidpid) {
                // Exact match by device ID — update port if it moved to a new COM port
                gRemoteDevicePort = devicePort;
                if (savedPort !== devicePort) {
                    await updateCfgComponent(configPath, 'device', 'port', devicePort);
                }
                vscode.window.showInformationMessage(`Device found: ${devicePort}`);
                break;
            } else if (!devId || devId === 'undefined') {
                // No saved device ID — ask user to confirm
                if (vidpid !== '0000:0000') {
                    const confirm = await vscode.window.showInformationMessage(
                        `Found device at ${devicePort} (ID: ${vidpid}). Use this device?`,
                        'Yes', 'No', 'Skip All'
                    );

                    if (confirm === 'Yes') {
                        gRemoteDevicePort = devicePort;
                        await updateCfgComponent(configPath, 'device', 'deviceId', vidpid);
                        await updateCfgComponent(configPath, 'device', 'port', devicePort);
                        break;
                    } else if (confirm === 'Skip All') {
                        break;
                    }
                    // If "No", continue to next device
                }
            }
        }

        if (gRemoteDevicePort) {
            console.log(`Selected device: ${gRemoteDevicePort}`);
        } else {
            vscode.window.showWarningMessage('No matching device found. Using saved port from config.');
        }
    } else {
        vscode.window.showWarningMessage('No connected devices detected.');
    }

    // ── WebREPL auto-connect — try BEFORE falling back to saved COM port ─────
    // If no live USB device was matched, probe for a WebREPL board on Wi-Fi.
    // This must run before the savedPort fallback so that a stale "COM7" in
    // device.cfg doesn't mask a live wireless device.
    if (!gRemoteDevicePort) {
        const webReplEnabled  = await getConfigValue(configPath, 'remote', 'webrepl_enabled');
        const webReplIp       = await getConfigValue(configPath, 'remote', 'webrepl_ip');
        const webReplPassword = await getConfigValue(configPath, 'remote', 'webrepl_password');

        if (webReplEnabled === 'true' && webReplIp) {
            const reachable = await checkWebReplReachable(webReplIp);
            if (reachable) {
                gRemoteDevicePort = `ws:${webReplIp},${webReplPassword || 'micro123'}`;
                vscode.window.showInformationMessage(
                    `📡 No USB device found — auto-connected wirelessly to ${webReplIp}`
                );
            } else {
                vscode.window.showWarningMessage(
                    `No USB device found. Wireless device at ${webReplIp} is not reachable either. ` +
                    `Check Wi-Fi or plug in USB.`
                );
            }
        }
    }

    // Last resort: fall back to the saved COM port from device.cfg
    if (!gRemoteDevicePort || gRemoteDevicePort === 'NOT_SET') {
        gRemoteDevicePort = savedPort;
    }

    deviceCodeDir = await getConfigValue(configPath, 'filePath', 'deviceCodeDir');
    const deviceFirmware = await getConfigValue(configPath, 'device', 'device_firmware');

    return [gRemoteDevicePort, deviceCodeDir, deviceFirmware || 'MicroPython'];
}

module.exports = { getValidDevicePort };