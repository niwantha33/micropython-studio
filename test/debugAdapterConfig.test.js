'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chooseDebugAdapter, findDebugConfigPath, findPotentialDebugPorts, validateDebugPort } = require('../src/debugAdapterConfig');
const { getConfigValue } = require('../src/commonFxn');

suite('MicroPython debugger adapter selection and persistence', () => {
    let root, cfg, code;
    const dualCdc = [
        { port: 'COM5', vidpid: '2E8A:0005', serial: 'board-1' }, // REPL
        { port: 'COM13', vidpid: '2E8A:0005', serial: 'board-1' } // debugger
    ];

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-debug-adapter-'));
        code = path.join(root, 'main', 'src');
        cfg = path.join(root, 'device.cfg');
        fs.mkdirSync(code, { recursive: true });
        fs.writeFileSync(cfg, '[device]\nport = "COM5"\ndeviceId = "2E8A:0005"\n', 'utf8');
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('possible dual CDC detection requires matching board serial AND VID:PID', () => {
        assert.deepStrictEqual(findPotentialDebugPorts('COM5', dualCdc), [dualCdc[1]]);
        assert.deepStrictEqual(findPotentialDebugPorts('COM5', [
            dualCdc[0], { port: 'COM13', serial: 'different-board', vidpid: '2E8A:0005' }
        ]), []);
        assert.deepStrictEqual(findPotentialDebugPorts('COM5', [
            { port: 'COM5', serial: 'None', vidpid: '2E8A:0005' },
            { port: 'COM13', serial: 'None', vidpid: '2E8A:0005' }
        ]), []);
        assert.deepStrictEqual(findPotentialDebugPorts('COM5', [
            dualCdc[0], { port: 'COM13', serial: 'board-1', vidpid: '0000:0000' }
        ]), []);
    });

    test('selects dedicated CDC, shows icons, and only updates [debug] in exact project file', async () => {
        const chosen = await chooseDebugAdapter(cfg, 'COM5', {
            devices: dualCdc,
            showQuickPick: async (items, config) => {
                assert.ok(config.placeHolder.includes('COM5'));
                assert.ok(items.every(item => item.manual || item.port !== 'COM5'));
                const debug = items.find(item => item.port === 'COM13');
                assert.ok(debug.label.includes('$(debug-alt)'));
                return debug;
            }
        });
        assert.strictEqual(chosen, 'COM13');
        assert.strictEqual(await getConfigValue(cfg, 'debug', 'adapter_port'), 'COM13');
        assert.strictEqual(await getConfigValue(cfg, 'device', 'port'), 'COM5');
        assert.strictEqual(await findDebugConfigPath({ uri: { fsPath: code } }), cfg);
    });

    test('reuses saved debugger on subsequent runs, with no prompt or REPL change', async () => {
        fs.appendFileSync(cfg, '[debug]\nadapter_port = "com13"\n');
        const picked = await chooseDebugAdapter(cfg, 'COM5', {
            devices: dualCdc,
            showQuickPick: () => { throw new Error('should not prompt'); }
        });
        assert.strictEqual(picked, 'COM13');
        assert.strictEqual(await getConfigValue(cfg, 'debug', 'adapter_port'), 'COM13');
        assert.strictEqual(await getConfigValue(cfg, 'device', 'port'), 'COM5');
    });

    test('missing saved CDC prompts rather than silently substituting another port', async () => {
        fs.appendFileSync(cfg, '[debug]\nadapter_port = "COM13"\n');
        const picked = await chooseDebugAdapter(cfg, 'COM5', {
            devices: [{ port: 'COM7', vidpid: '2E8A:0005' }, dualCdc[0]],
            showQuickPick: async items => {
                assert.ok(items.some(i => i.port === 'COM7'));
                assert.ok(items.some(i => i.port === 'COM13' && i.label.includes('$(warning)')));
                return undefined; // cancelled
            }
        });
        assert.strictEqual(picked, null);
        assert.strictEqual(await getConfigValue(cfg, 'debug', 'adapter_port'), 'COM13');
    });

    test('manual adapter entry validates against REPL and persists selection', async () => {
        const selected = await chooseDebugAdapter(cfg, 'COM5', {
            devices: dualCdc,
            showQuickPick: async items => items.find(i => i.manual),
            showInputBox: async opts => {
                assert.ok(opts.validateInput('com5'));
                assert.strictEqual(opts.validateInput('COM8'), null);
                return 'COM8';
            }
        });
        assert.strictEqual(selected, 'COM8');
        assert.strictEqual(await getConfigValue(cfg, 'debug', 'adapter_port'), 'COM8');
        assert.strictEqual(await getConfigValue(cfg, 'device', 'port'), 'COM5');
    });

    test('launch.json port is saved, but never allowed to alias REPL', async () => {
        assert.ok(validateDebugPort('COM5', 'com5'));
        assert.ok(validateDebugPort('ws:10.0.0.1,password', 'COM5'));
        assert.ok(validateDebugPort('COM3\nINJECT', 'COM5'));
        await assert.rejects(
            chooseDebugAdapter(cfg, 'COM5', { requestedPort: 'COM5', devices: dualCdc }),
            /OTHER, dedicated debug CDC/
        );
        assert.strictEqual(await getConfigValue(cfg, 'debug', 'adapter_port'), null);
        const selected = await chooseDebugAdapter(cfg, 'COM5', {
            requestedPort: 'COM14', devices: dualCdc,
            showQuickPick: () => { throw new Error('explicit port should not prompt'); }
        });
        assert.strictEqual(selected, 'COM14');
        assert.strictEqual(await getConfigValue(cfg, 'debug', 'adapter_port'), 'COM14');
    });

    test('no detected ports can be configured manually without guessing', async () => {
        const selected = await chooseDebugAdapter(cfg, 'COM5', {
            devices: [],
            showQuickPick: async items => {
                assert.strictEqual(items.length, 1);
                return items[0];
            },
            showInputBox: async () => '/dev/ttyACM1'
        });
        assert.strictEqual(selected, '/dev/ttyACM1');
        assert.strictEqual(await getConfigValue(cfg, 'debug', 'adapter_port'), '/dev/ttyACM1');
    });
});
