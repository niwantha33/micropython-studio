'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectConfiguredPort } = require('../src/devicePortSelection');
const { findProjectRoot } = require('../src/refreshSettings');
const { updateCfgComponent, getConfigValue } = require('../src/commonFxn');

suite('device.cfg selected port persistence', () => {
    const dualCdc = [
        { port: 'COM3', serial: 'pico-001', vidpid: '2E8A:0005' }, // same physical board
        { port: 'COM5', serial: 'pico-001', vidpid: '2E8A:0005' }, // user-selected REPL port
    ];

    test('saved COM5 wins even when another CDC interface has same VID:PID', () => {
        assert.deepStrictEqual(
            selectConfiguredPort('COM5', dualCdc),
            { port: 'COM5', present: true }
        );
        assert.deepStrictEqual(
            selectConfiguredPort('com5', dualCdc),
            { port: 'COM5', present: true }
        );
    });

    test('refresh never changes COM5 to COM3 when COM5 is unplugged', () => {
        assert.deepStrictEqual(
            selectConfiguredPort('COM5', [dualCdc[0]]),
            { port: 'COM5', present: false }
        );
        assert.deepStrictEqual(
            selectConfiguredPort('COM5', []),
            { port: 'COM5', present: false }
        );
        assert.deepStrictEqual(
            selectConfiguredPort('NOT_SET', dualCdc),
            { port: null, present: false }
        );
    });

    test('write and reread exact project device.cfg from nested code directory', async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-port-config-'));
        const project = path.join(temp, 'project');
        const main = path.join(project, 'main', 'src', 'nested');
        const unrelated = path.join(temp, 'project', 'main', 'device.cfg');
        const cfg = path.join(project, 'device.cfg');
        try {
            fs.mkdirSync(main, { recursive: true });
            fs.writeFileSync(cfg, [
                '[device]',
                'port = "COM3"',
                'deviceId = "2E8A:0005"',
                '',
                '[filePath]',
                'deviceCodeDir = "' + main.replaceAll('\\', '\\\\') + '"',
                ''
            ].join('\n'));
            assert.strictEqual(await findProjectRoot(main), project);
            const actualCfg = path.join(await findProjectRoot(main), 'device.cfg');
            assert.strictEqual(actualCfg, cfg);
            assert.notStrictEqual(actualCfg, unrelated);

            await updateCfgComponent(actualCfg, 'device', 'port', 'COM5');
            await updateCfgComponent(actualCfg, 'device', 'run_transport', 'usb');
            assert.strictEqual(await getConfigValue(cfg, 'device', 'port'), 'COM5');
            assert.strictEqual(await getConfigValue(cfg, 'device', 'run_transport'), 'usb');
            assert.deepStrictEqual(
                selectConfiguredPort(await getConfigValue(cfg, 'device', 'port'), dualCdc),
                { port: 'COM5', present: true }
            );
            assert.strictEqual(fs.existsSync(unrelated), false);
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    });

    test('refresh uses saved COM5 even when dual-CDC filtering would choose COM3', async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-port-refresh-'));
        const code = path.join(temp, 'main');
        const config = path.join(temp, 'device.cfg');
        const runCmd = require('../src/runCommand');
        const originalDetector = runCmd.getConnectedDevices;
        const refreshModule = require.resolve('../src/refreshSettings');
        const originalCache = require.cache[refreshModule];
        try {
            fs.mkdirSync(code);
            fs.writeFileSync(config, [
                '[device]',
                'port = "COM5"',
                'deviceId = "2E8A:0005"',
                'device_firmware = "MicroPython"',
                '',
                '[filePath]',
                'deviceCodeDir = "' + code.replaceAll('\\', '\\\\') + '"'
            ].join('\n'));
            // Inject the exact dual-CDC enumeration order that previously
            // caused the explicit COM5 preference to snap back to COM3.
            runCmd.getConnectedDevices = async () => dualCdc;
            delete require.cache[refreshModule];
            const { getValidDevicePort } = require('../src/refreshSettings');
            const [selected, codeDir, firmware, configPath] = await getValidDevicePort({ fsPath: code });
            assert.strictEqual(selected, 'COM5');
            assert.strictEqual(codeDir, code);
            assert.strictEqual(firmware, 'MicroPython');
            assert.strictEqual(configPath, config);
            assert.strictEqual(await getConfigValue(config, 'device', 'port'), 'COM5');
        } finally {
            runCmd.getConnectedDevices = originalDetector;
            delete require.cache[refreshModule];
            if (originalCache) require.cache[refreshModule] = originalCache;
            fs.rmSync(temp, { recursive: true, force: true });
        }
    });

    test('all port selection handlers use one canonical configuration path', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
        const refresh = fs.readFileSync(path.join(__dirname, '..', 'src', 'refreshSettings.js'), 'utf8');
        assert.ok(src.includes('gDeviceConfigPath = comValues[3] || null'));
        assert.ok(src.includes('async function saveSelectedDevicePort(port)'));
        assert.ok(src.includes('gRemoteDevicePort = await saveSelectedDevicePort(port)'));
        assert.ok(src.includes('gRemoteDevicePort = await saveSelectedDevicePort(newPort)'));
        assert.ok(refresh.includes('selectConfiguredPort(savedPort, devicesRaw)'));
        assert.ok(refresh.includes("const preferredTransport = await getConfigValue(configPath, 'device', 'run_transport')"));
        assert.ok(!refresh.includes("Device ID match found at new port"));
    });
});
