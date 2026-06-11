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
 * Group connected devices by physical USB serial number and filter out secondary CDC ports.
 * The primary port is assumed to be the one with the lowest numerical or lexicographical port ID.
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
            const logStr = `[Port Detection] Dual-CDC detected for serial ${ser}: Primary REPL = ${groupDevices[0].port}, Debug/Secondary = ${groupDevices.slice(1).map(x => x.port).join(', ')}`;
            console.log(logStr);
            try {
                const channel = vscode.window.createOutputChannel('MicroPython IDE');
                channel.appendLine(logStr);
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

    const devicesRaw = await getConnectedDevices();
    const devices = filterDualCdcPorts(devicesRaw);

    const logMsg = (msg) => {
        console.log(msg);
        try {
            const channel = vscode.window.createOutputChannel('MicroPython IDE');
            channel.appendLine(msg);
        } catch (_) {}
    };

    logMsg(`[Port Detection] Raw connected devices: ${JSON.stringify(devicesRaw)}`);
    logMsg(`[Port Detection] Filtered connected devices (REPL candidates): ${JSON.stringify(devices)}`);

    if (devices.length > 0) {
        // Step 1: Priority check — is the savedPort still available and matching the deviceId?
        // This is critical for Dual-CDC devices where multiple ports share the same VID:PID.
        const exactMatch = devices.find(d => d.port === savedPort && d.vidpid === devId);
        
        if (exactMatch) {
            gRemoteDevicePort = savedPort;
            logMsg(`[Port Detection] Matched saved port: ${savedPort}`);
        } else {
            // Step 2: Fallback — find ANY device that matches the deviceId
            for (const device of devices) {
                const devicePort = device.port;
                const vidpid = device.vidpid;

                if (devId && devId !== 'undefined' && devId === vidpid) {
                    // Match by device ID — update port if it transitioned to a new COM port
                    gRemoteDevicePort = devicePort;
                    if (savedPort !== devicePort) {
                        console.log(`Device ID match found at new port: ${devicePort}`);
                        await updateCfgComponent(configPath, 'device', 'port', devicePort);
                    }
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
                    }
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