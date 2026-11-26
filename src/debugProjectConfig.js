'use strict';

const vscode = require('vscode');
const path = require('path');
const { findProjectRoot } = require('./refreshSettings');
const { getConfigValue } = require('./commonFxn');
const { normalizeSerialPort, isSavedUsbPort } = require('./devicePortSelection');
const { chooseDebugAdapter } = require('./debugAdapterConfig');

const DEBUG_TYPE = 'micropython-studio';

function defaultAttachConfiguration() {
    return {
        type: DEBUG_TYPE,
        request: 'attach',
        name: 'MicroPython Studio: Attach to hardware',
        replPort: '',
        debugPort: ''
    };
}

async function findDebugCfgPath(folder) {
    const workspace = folder?.uri?.fsPath ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) return null;
    const projectRoot = await findProjectRoot(workspace);
    return projectRoot ? path.join(projectRoot, 'device.cfg') : null;
}

async function resolveReplPort(configPort, runtimePort, folder) {
    // An explicit launch.json override wins; otherwise device.cfg is the
    // project authority. A stale in-memory COM must not override a port the
    // user selected and saved before clicking Start Debug.
    const explicit = normalizeSerialPort(configPort);
    if (isSavedUsbPort(explicit) && explicit !== '-') return explicit;
    const cfg = await findDebugCfgPath(folder);
    const saved = cfg ? await getConfigValue(cfg, 'device', 'port') : null;
    if (isSavedUsbPort(saved)) return normalizeSerialPort(saved);
    const fallback = normalizeSerialPort(runtimePort);
    return isSavedUsbPort(fallback) && fallback !== '-' ? fallback : null;
}

/**
 * Never infer debugger CDC from VID:PID or lowest COM index. Use an explicitly
 * saved interface while present; otherwise require a human choice.
 */
async function resolveDebugPort(folder, replPort, explicitPort = '', forcePicker = false, adapterOptions = {}) {
    const cfg = await findDebugCfgPath(folder);
    if (!cfg) throw new Error('No MicroPython project device.cfg found. Open or refresh your project.');
    // Keep native and legacy debugging on the same confirmed CDC adapter.
    return chooseDebugAdapter(cfg, normalizeSerialPort(replPort), {
        ...adapterOptions,
        requestedPort: normalizeSerialPort(explicitPort),
        force: forcePicker
    });
}

module.exports = { defaultAttachConfiguration, findDebugCfgPath, resolveReplPort, resolveDebugPort };
