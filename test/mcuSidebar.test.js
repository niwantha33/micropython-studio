'use strict';
const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { parseConfig, findConfig, connectionState, projectRows, runtimeRows } = require('../src/mcuSidebarModel');

suite('MCU sidebar passive information', () => {
    test('shows configured board and separate CDC without exposing secrets', () => {
        const cfg = parseConfig('[device]\nmcu = Raspberry Pi Pico W\nport = ws:192.168.1.2,SECRET\nrun_transport = webrepl\nlast_flashed_version = 1.27\n[debug]\nadapter_port = COM5\n[remote]\nwebrepl_password = SECRET\n[filePath]\nvirtualPython = PRIVATE');
        const visible = JSON.stringify(projectRows(path.resolve('example', 'device.cfg'), cfg));
        assert.ok(visible.includes('Raspberry Pi Pico W'));
        assert.ok(visible.includes('COM5'));
        assert.ok(visible.includes('WebREPL (configured)'));
        assert.ok(!visible.includes('SECRET'));
        assert.ok(!visible.includes('PRIVATE'));
        assert.strictEqual(parseConfig('[device]\nport = NOT_SET').repl, '');
    });
    test('does not claim a different port is connected or unknown heap is zero', () => {
        const connection = { isConnected: true, portName: 'COM7', isScriptRunning: true };
        assert.strictEqual(connectionState(connection, 'COM5'), 'REPL not connected');
        assert.strictEqual(connectionState(connection, 'com7'), 'REPL script running');
        assert.strictEqual(connectionState({ ...connection, isSuspended: true }, 'COM7'), 'REPL temporarily unavailable');
        const rows = runtimeRows('REPL connected', true, null, false);
        assert.ok(rows.some(row => row[1] === 'No scoped snapshot'));
        assert.ok(rows.every(row => row.length === 3));
        const measured = runtimeRows('REPL connected', false, { allocated: 0, total: 1024, free: 1024, timestamp: 0 }, true);
        assert.ok(measured.some(row => row[1] === '0.0 KiB / 1.0 KiB'));
    });
    test('finds nested project but never inherits configuration above workspace', async () => {
        const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mps-sidebar-'));
        try {
            const root = path.join(parent, 'workspace');
            const nested = path.join(root, 'project', 'main');
            await fs.mkdir(nested, { recursive: true });
            await fs.writeFile(path.join(parent, 'device.cfg'), '[device]');
            assert.strictEqual(await findConfig(nested, root), null);
            const expected = path.join(root, 'project', 'device.cfg');
            await fs.writeFile(expected, '[device]');
            assert.strictEqual(await findConfig(nested, root), expected);
            assert.strictEqual(await findConfig(parent, root), null);
        } finally { await fs.rm(parent, { recursive: true, force: true }); }
    });
    test('manifest contributes both views to Run and Debug with project context', () => {
        const views = require('../package.json').contributes.views.debug;
        assert.deepStrictEqual(views.map(view => view.name), ['MCU Project', 'MCU Runtime']);
        assert.ok(views.every(view => view.when === 'micropythonStudio.hasMcuProject'));
    });
});
