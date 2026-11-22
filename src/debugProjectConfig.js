'use strict';

const vscode = require('vscode');
const path = require('path');
const { findProjectRoot } = require('./refreshSettings');
const { getConfigValue, updateCfgComponent } = require('./commonFxn');
const { getConnectedDevices } = require('./runCommand');
const { normalizeSerialPort, samePort, isSavedUsbPort } = require('./devicePortSelection');
const { pickSerialAdapter } = require('./serialAdapterPicker');

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
    const direct = normalizeSerialPort(configPort || runtimePort || '');
    if (isSavedUsbPort(direct) && direct !== '-') return direct;
    const cfg = await findDebugCfgPath(folder);
    const saved = cfg ? await getConfigValue(cfg, 'device', 'port') : null;
    return isSavedUsbPort(saved) ? normalizeSerialPort(saved) : null;
}

/**
 * Never infer debugger CDC from VID:PID or lowest COM index. Use an explicitly
 * saved interface while present; otherwise require a human choice.
 */
async function resolveDebugPort(folder, replPort, explicitPort = '', forcePicker = false) {
    const cfg = await findDebugCfgPath(folder);
    if (!cfg) throw new Error('No MicroPython project device.cfg found. Open or refresh your project.');
    const repl = normalizeSerialPort(replPort);
    const provided = normalizeSerialPort(explicitPort);
    const saved = await getConfigValue(cfg, 'debug', 'port');
    const candidate = normalizeSerialPort(provided || saved || '');
    const devices = await getConnectedDevices().catch(() => []);
    let selected;

    if (!forcePicker && provided) {
        selected = provided;
    } else if (!forcePicker && candidate && devices.some(d => samePort(d.port, candidate))) {
        selected = candidate;
    } else {
        selected = await pickSerialAdapter({
            selected: candidate,
            excludePort: repl,
            purpose: 'Debugger (separate CDC)'
        });
    }
    if (!selected) return null;
    if (!isSavedUsbPort(selected) || selected === '-' || samePort(selected, repl)) {
        throw new Error('Debug adapter must be a valid COM port different from the REPL USB port.');
    }
    selected = normalizeSerialPort(selected);
    await updateCfgComponent(cfg, 'debug', 'port', selected);
    return selected;
}

module.exports = { defaultAttachConfiguration, findDebugCfgPath, resolveReplPort, resolveDebugPort };
