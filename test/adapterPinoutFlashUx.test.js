'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeSerialPort, selectConfiguredPort } = require('../src/devicePortSelection');
const { buildSerialAdapterItems, validateManualPort } = require('../src/serialAdapterPicker');
const { SIMPLE_PROFILES, getSimpleFlashProfile, prepareSimpleFirmwareRows } = require('../src/flashProfiles');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');

suite('USB adapter and Flash UX regressions', () => {
    test('COM strings are canonically displayed and saved as uppercase', () => {
        assert.strictEqual(normalizeSerialPort('com5'), 'COM5');
        assert.strictEqual(normalizeSerialPort('CoM13'), 'COM13');
        assert.strictEqual(normalizeSerialPort('/dev/ttyACM0'), '/dev/ttyACM0');
        assert.deepStrictEqual(selectConfiguredPort('com5', [
            { port: 'COM3', vidpid: '2e8a:0005', serial: 'same' },
            { port: 'com5', vidpid: '2e8a:0005', serial: 'same' }
        ]), { port: 'COM5', present: true });
    });

    test('both CDC adapters remain selectable with explicit REPL/debug separation', () => {
        const devices = [
            { port: 'com3', serial: 'board-1', vidpid: '2E8A:0005' },
            { port: 'com5', serial: 'board-1', vidpid: '2E8A:0005' }
        ];
        const repl = buildSerialAdapterItems(devices, 'com5');
        assert.strictEqual(repl.length, 2);
        assert.ok(repl[0].label.includes('COM3'));
        assert.ok(repl[1].label.includes('COM5'));
        assert.strictEqual(repl[1].description, 'Currently selected');
        const debug = buildSerialAdapterItems(devices, 'COM3', 'COM5');
        assert.strictEqual(debug.length, 1);
        assert.strictEqual(debug[0].port, 'COM3');
        assert.strictEqual(validateManualPort('com5'), null);
        assert.strictEqual(validateManualPort('/dev/ttyACM0'), null);
        assert.ok(validateManualPort('COM5 && bad'));
    });

    test('native and legacy debugging select and persist a dedicated COM adapter', () => {
        const native = source('nativeDebugger.js');
        const legacy = source('mpyDebugger.js');
        const settings = source('debugAdapterSettings.js');
        assert.ok(native.includes('chooseDebugAdapter(repl, config.debugPort)'));
        assert.ok(legacy.includes('chooseDebugAdapter(normalizeSerialPort(replPort))'));
        assert.ok(settings.includes("'debug', 'port', candidate"));
        assert.ok(settings.includes('samePort(candidate, repl)'));
        assert.ok(!native.includes("prompt: 'MicroPython debugger CDC port"));
    });

    test('Dashboard board and pin assignments survive refresh and reopen', () => {
        const dashboard = source('deviceDashboard.js');
        assert.ok(dashboard.includes('getConfigValue(dashboardCfgPath, "dashboard", "pinout_board")'));
        assert.ok(dashboard.includes('updateCfgComponent(dashboardCfgPath, "dashboard", "pinout_board", key)'));
        assert.ok(dashboard.includes("command: 'dashboardReady'"));
        assert.ok(dashboard.includes('scanWorkspacePins(workspaceRoot)'));
        assert.ok(dashboard.includes('panel.webview.html = getWebviewContent(metrics)'));
        assert.ok(dashboard.includes('command: "pinMapResults", pinMap'));
    });

    test('simple ESP flashing always uses verified offsets, not stale offsets', () => {
        assert.strictEqual(SIMPLE_PROFILES.esp32.offset, '0x1000');
        assert.strictEqual(SIMPLE_PROFILES.esp32s2.offset, '0x1000');
        assert.strictEqual(SIMPLE_PROFILES.esp32s3.offset, '0x0');
        assert.strictEqual(SIMPLE_PROFILES.esp32c3.offset, '0x0');
        assert.strictEqual(SIMPLE_PROFILES.esp32c6.offset, '0x0');
        assert.strictEqual(SIMPLE_PROFILES.esp8266.offset, '0x0');
        assert.strictEqual(getSimpleFlashProfile('esp32c5'), null);
        const rows = prepareSimpleFirmwareRows('esp32s3',
            [{ enabled: true, path: '/tmp/my-firmware.bin', offset: '0x1000' }]);
        assert.strictEqual(rows[0].offset, '0x0');
        assert.strictEqual(rows[0].path, '/tmp/my-firmware.bin');
        assert.ok(rows.slice(1).every(item => item.enabled === false));
        assert.throws(() => prepareSimpleFirmwareRows('esp32p4', []), /Advanced Flashing/);
    });

    test('simple ESP flashing requires file validation, explicit confirmation and exclusive serial ownership', () => {
        const flash = source('espFlashTool.js');
        const extension = source('extension.js');
        assert.ok(flash.includes('getSimpleFlashProfile(settings.chipType).offset'));
        assert.ok(flash.includes("'/\\.bin$/i") || flash.includes("/\\.bin$/i"));
        assert.ok(flash.includes("confirmation !== 'Flash Firmware'"));
        assert.ok(flash.includes("Firmware flash (exclusive COM handoff)"));
        assert.ok(flash.includes('wsQueue.run('));
        assert.ok(flash.includes('isSavedUsbPort(selectedPort)'));
        assert.ok(extension.includes('SIMPLE_PROFILES'));
        assert.ok(extension.includes("selection.action === 'simpleEsp'"));
        assert.ok(extension.includes("selection.action === 'advanced'"));
    });
});
