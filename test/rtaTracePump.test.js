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
    test('trace pump resync avoids unsupported bytearray pop', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'debugger_files', 'trace_pump.py'),
            'utf8'
        );
        assert.ok(!source.includes('cmd_buf.pop(0)'));
        assert.ok(source.includes('cmd_buf[:] = cmd_buf[1:]'));
    });

    test('Studio verifies uploaded pump on REPL but Connect only uses debug CDC exclusively', () => {
        const pump = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'debugger_files', 'trace_pump.py'),
            'utf8'
        );
        const boot = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'debugger_files', 'boot.py'),
            'utf8'
        );
        const host = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
            'utf8'
        );

        assert.ok(pump.includes('PUMP_PROTOCOL = 4'));
        assert.ok(pump.includes('PUMP_BUILD = "2026-10-07-bytearray-resync-v4"'));
        assert.ok(host.includes("'cat', '--port', replPort, '--path', '/trace_pump.py'"));
        assert.ok(host.includes("const hasOldPop = r.out.includes('cmd_buf.pop(0)')"));

        assert.ok(!host.includes('async function prepareLivePump'));
        assert.ok(host.includes("prompt: 'Debug CDC port (the SECOND COM port Windows shows for the board)'"));
        assert.ok(host.includes("op: 'debug CDC open; verifying trace_pump'"));
        assert.ok(host.includes("msg.text.startsWith('cleared all bp slots')"));
        assert.ok(host.includes('installCurrentBreakpoints();'));

        assert.ok(boot.includes('trace_pump.start()'));
        assert.ok(boot.includes('[boot] trace_pump auto-start requested'));
    });

});
