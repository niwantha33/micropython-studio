const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseRtaNameReply } = require('../src/rtaNameParser');

suite('RTA live VM symbol replies', () => {
    test('parses a valid hex function pointer and function name', () => {
        assert.deepStrictEqual(
            parseRtaNameReply('rta_name=200344d0:get_gpio_state'),
            { fun: 0x200344d0, name: 'get_gpio_state' }
        );
        assert.deepStrictEqual(
            parseRtaNameReply('rta_name=100010a0:main'),
            { fun: 0x100010a0, name: 'main' }
        );
    });

    test('rejects malformed replies, controls and arbitrary memory addresses', () => {
        for (const text of [
            '', null, 'rta_name=xyz:get_gpio_state', 'rta_name=0:get_gpio_state',
            'rta_name=00000000:a', 'rta_name=200344d0:',
            'rta_name=200344d0:hello\nreply', 'rta_name=200344d0:\x01evil',
            'rta_name=200344d0:' + 'x'.repeat(73),
            'rta_name=200344d0:hello:extra'
        ]) {
            assert.strictEqual(parseRtaNameReply(text), null, String(text));
        }
    });

    test('uses optional existing text replies: no new USB command or raw RAM reads', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');
        assert.ok(source.includes("const { parseRtaNameReply } = require('./rtaNameParser');"));
        assert.ok(source.includes("const liveSymbol = parseRtaNameReply(msg.text);"));
        assert.ok(source.includes("evt: 'rta_name'"));
        assert.ok(source.includes("parseRtaNameReply(msg.text) !== null"));
        assert.ok(source.includes("requestSymbolMap();")); // preserve legacy fallback
        assert.ok(source.includes("requestTaskMap();")); // preserve asyncio fallback
        const bridge = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'dbg_bridge.py'), 'utf8');
        assert.ok(bridge.includes('say(evt="reply", text=text)'));
        assert.ok(!source.includes('machine.mem32[fun]'));
    });
});
