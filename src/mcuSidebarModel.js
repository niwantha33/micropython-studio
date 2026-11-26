'use strict';
const fs = require('fs').promises;
const path = require('path');
const { redactDevicePort } = require('./commonFxn');
const { samePort } = require('./devicePortSelection');

function within(root, candidate) {
    const rel = path.relative(root, candidate);
    return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

async function findConfig(start, root) {
    if (!start || !root || !within(root, start)) return null;
    for (let dir = start; ; dir = path.dirname(dir)) {
        const file = path.join(dir, 'device.cfg');
        try {
            if ((await fs.stat(file)).isFile()) return file;
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
        if (path.relative(root, dir) === '') return null;
    }
}

function clean(value) {
    const text = value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240);
    return /^(?:NOT_SET|undefined|null|-)$/i.test(text) ? '' : text;
}

function parseConfig(content) {
    const fields = {
        'device.mcu': 'board', 'device.device_firmware': 'firmware',
        'device.port': 'repl', 'device.run_transport': 'transport',
        'debug.adapter_port': 'adapter', 'debug.port': 'legacyAdapter',
        'device.last_flashed_version': 'lastFlashed'
    };
    const result = {};
    let section = '';
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || /^[#;]/.test(trimmed)) continue;
        const heading = /^\[([^\]]+)\]$/.exec(trimmed);
        if (heading) { section = heading[1]; continue; }
        const entry = /^([^=]+)=(.*)$/.exec(trimmed);
        if (!entry) continue;
        const key = fields[section + '.' + entry[1].trim()];
        if (!key || Object.prototype.hasOwnProperty.call(result, key)) continue;
        let value = entry[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (['repl', 'adapter', 'legacyAdapter'].includes(key)) value = redactDevicePort(value.trim());
        result[key] = clean(value);
    }
    return result;
}

function connectionState(connection, port) {
    if (!port) return 'Not selected for this project';
    if (/^wss?:/i.test(port)) return 'WebREPL — status not monitored here';
    if (!connection.isConnected || !samePort(connection.portName, port)) return 'REPL not connected';
    if (connection.isSuspended || connection.isReconnecting) return 'REPL temporarily unavailable';
    return connection.isScriptRunning ? 'REPL script running' : 'REPL connected';
}

function bytes(value) {
    return Number.isSafeInteger(value) && value >= 0 ? (value / 1024).toFixed(1) + ' KiB' : 'Unavailable';
}

function projectRows(configPath, cfg) {
    return [
        ['Project', path.basename(path.dirname(configPath)), 'folder'],
        ['Board / MCU', cfg.board || 'Not configured', 'circuit-board'],
        ['Firmware family', cfg.firmware || 'Not recorded', 'symbol-class'],
        ['Last flashed version', cfg.lastFlashed || 'Not recorded', 'versions'],
        ['Transport', cfg.transport === 'webrepl' || /^wss?:/i.test(cfg.repl || '') ? 'WebREPL (configured)' :
            cfg.transport === 'usb' || cfg.repl ? 'USB / serial (configured)' : 'Not configured', 'plug'],
        ['Saved REPL port', cfg.repl || 'Not configured', 'terminal'],
        ['Saved debug CDC', cfg.adapter || cfg.legacyAdapter || 'Not configured', 'debug-alt'],
        ['device.cfg', 'Open project configuration', 'file-code', 'micropython-ide.openMcuConfig']
    ];
}

function runtimeRows(state, nativeSession, sample, tools) {
    const rows = [
        ['Connection', state, 'plug'],
        ['Debugger', nativeSession ? 'Native VS Code session active (target not verified)' : 'No active native VS Code session', 'debug-alt'],
        ['Heap used / total', sample ? bytes(sample.allocated) + ' / ' + bytes(sample.total) : 'No scoped snapshot', 'graph'],
        ['Heap free', sample ? bytes(sample.free) : 'No scoped snapshot', 'database'],
        ['Snapshot time', sample ? new Date(sample.timestamp).toLocaleString() : 'Open Memory & GC to sample', 'history']
    ];
    if (tools) {
        rows.push(['Memory & GC', 'Open analyzer (manual sampling)', 'pulse', 'micropython-ide.openMemoryAnalyzer']);
        rows.push(['Device Dashboard', 'Hardware and filesystem details', 'dashboard', 'micropython-ide.openDeviceDashboard']);
        rows.push(['Debugger Details', 'Native debugger / RTA details', 'debug-alt', 'micropython-ide.showDebuggerDetails']);
    }
    return rows;
}

module.exports = { within, findConfig, parseConfig, connectionState, projectRows, runtimeRows };
