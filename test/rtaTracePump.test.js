const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('RTA on/off regression', () => {
    test('trace pump bounds draining so RTA OFF cannot be starved', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'debugger_files', 'trace_pump.py'),
            'utf8'
        );

        assert.match(source, /chunks\s*=\s*0[\s\S]*while chunks < 8:[\s\S]*chunks \+= 1/);
        assert.ok(source.includes('elif cmd_type == 0x1B:'), 'RTA ON command handler is missing');
        assert.ok(source.includes('elif cmd_type == 0x1C:'), 'RTA OFF command handler is missing');
        assert.ok(source.includes('RTA unsupported by firmware: flash an RTA-capable debug firmware'));
    });

    test('bridge closes RTA before dropping the CDC connection', () => {
        const bridge = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'dbg_bridge.py'),
            'utf8'
        );
        assert.ok(bridge.includes('ser.write(bytes([0xAA, 0x1C, 0x00]))'));
        assert.ok(bridge.includes('do not leave target RTA running'));
    });

    test('host waits for device confirmation before changing RTA state', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
            'utf8'
        );

        assert.ok(source.includes("msg.text === 'RTA trace enabled'"));
        assert.ok(source.includes("msg.text === 'RTA trace disabled'"));
        assert.ok(!source.includes("msg.evt === 'sent' && msg.op === 'rta_off'"));
        assert.ok(!source.includes("msg.evt === 'sent' && msg.op === 'rta_on'"));
    });
});
