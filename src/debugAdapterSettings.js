'use strict';

const vscode = require('vscode');
const path = require('path');
const { findProjectRoot } = require('./refreshSettings');
const { getConfigValue, updateCfgComponent } = require('./commonFxn');
const { normalizeSerialPort, samePort } = require('./devicePortSelection');
const { pickSerialAdapter } = require('./serialAdapterPicker');

/** Debug uses a separate CDC; unlike REPL it must never change [device] port. */
async function getDebugConfigPath() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) throw new Error('Open the MicroPython project before starting Debug.');
    const root = await findProjectRoot(folder);
    if (!root) throw new Error('Project device.cfg not found. Refresh Device Files first.');
    return path.join(root, 'device.cfg');
}

async function chooseDebugAdapter(replPort, requestedPort) {
    const cfgPath = await getDebugConfigPath();
    const stored = await getConfigValue(cfgPath, 'debug', 'port');
    const selected = normalizeSerialPort(requestedPort || stored || '');
    const repl = normalizeSerialPort(replPort);
    // Explicit launch.json overrides get priority, but still must not
    // target the interactive USB REPL interface.
    const chosen = requestedPort
        ? selected
        : await pickSerialAdapter({ selected, excludePort: repl, purpose: 'Debugger' });
    if (!chosen) return null;
    const candidate = normalizeSerialPort(chosen);
    if (samePort(candidate, repl)) {
        throw new Error('Debugger COM and USB REPL COM must be different physical interfaces.');
    }
    // Only persist a known-good nonempty manual choice. An actual handshake
    // is performed by the debug bridge after the adapter is selected.
    await updateCfgComponent(cfgPath, 'debug', 'port', candidate);
    return candidate;
}

module.exports = { getDebugConfigPath, chooseDebugAdapter };
