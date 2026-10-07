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

        assert.ok(pump.includes('PUMP_PROTOCOL = 5'));
        assert.ok(pump.includes('PUMP_BUILD = "2026-10-07-bp-manager-v5"'));
        assert.ok(host.includes("'cat', '--port', replPort, '--path', '/trace_pump.py'"));
        assert.ok(host.includes("const hasOldPop = r.out.includes('cmd_buf.pop(0)')"));

        assert.ok(!host.includes('async function prepareLivePump'));
        assert.ok(host.includes("prompt: 'Debug CDC port (the SECOND COM port Windows shows for the board)'"));
        assert.ok(host.includes("op: 'debug CDC open; probing pump capability'"));
        assert.ok(host.includes("msg.text.startsWith('pump_info=')"));
        assert.ok(host.includes("msg.text.startsWith('cleared all bp slots')"));
        assert.ok(host.includes("evt: 'pump_capability'"));
        assert.ok(host.includes('installCurrentBreakpoints();'));

        assert.ok(boot.includes('CDCInterface(timeout=0, txbuf=4096, rxbuf=512)'));
        assert.ok(!boot.includes('time.sleep(3)'));
        assert.ok(boot.includes('trace_pump.start()'));
        assert.ok(boot.includes('[boot] trace_pump supervisor started'));
    });

    test('debug CDC endpoint IO waits for Windows host-open DTR', () => {
        const pump = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'debugger_files', 'trace_pump.py'),
            'utf8'
        );
        const bridge = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'dbg_bridge.py'),
            'utf8'
        );

        assert.ok(pump.includes('host_connected = bool(cdc.is_open() and cdc.dtr)'));
        assert.ok(pump.includes('if not host_connected:'));
        assert.ok(pump.includes('cmd_buf[:] = b\'\''));
        assert.ok(bridge.includes('ser.dtr = True'));
        assert.ok(bridge.includes('ser.rts = False'));
        assert.ok(bridge.includes('time.sleep(0.20)'));
    });

    test('v5 capability probe falls back to legacy breakpoint handshake', () => {
        const host = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
            'utf8'
        );
        assert.ok(host.includes("op: 'no pump_info reply; trying legacy breakpoint handshake'"));
        assert.ok(host.includes('legacy compatibility mode'));
        assert.ok(host.includes('supportsListBp = false'));
        assert.ok(host.includes("msg.text.startsWith('cleared all bp slots')"));
    });

    test('transport loss stops repeated writes to a dead COM handle', () => {
        const bridge = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'dbg_bridge.py'),
            'utf8'
        );
        const host = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
            'utf8'
        );
        assert.ok(bridge.includes('evt="transport_lost"'));
        assert.ok(host.includes("msg.evt === 'transport_lost'"));
        assert.ok(host.includes('DEBUG CDC LOST'));
    });

});
