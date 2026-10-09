const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

suite('Live RTA viewer', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
        'utf8'
    );

    test('renders a FreeRTOS-style live runtime table', () => {
        assert.ok(source.includes('LIVE RTA · TASK / FUNCTION VIEWER'));
        assert.ok(source.includes('id="rta-table-body"'));
        assert.ok(source.includes('Observed VM %'));
        assert.ok(source.includes('Activations'));
        assert.ok(source.includes('Highest Runtime'));
        assert.ok(source.includes('Reset Stats'));
    });

    test('scrolls the full debugger page instead of clipping bottom panels', () => {
        assert.match(source, /body \{[^}]*min-height: 100vh;[^}]*height: auto;[^}]*overflow-y: auto;/);
        assert.doesNotMatch(source, /body \{[^}]*overflow: hidden;/);
        assert.match(source, /\.dashboard-grid \{[^}]*flex: 0 0 auto;/);
        assert.match(source, /\.panels-container \{[^}]*overflow: visible;/);
        assert.match(source, /\.panel-terminal \{[^}]*height: clamp\(320px, 52vh, 640px\);/);
        assert.match(source, /#log \{[^}]*overflow-y: auto;/);
        assert.match(source, /\.rta-table-wrap \{[^}]*max-height: 260px;[^}]*overflow: auto;/);
    });

    test('provides direct keyboard-friendly shortcuts to the lower panels', () => {
        assert.ok(source.includes('aria-label="Jump to debugger panels"'));
        assert.ok(source.includes('href="#debug-console"'));
        assert.ok(source.includes('href="#panel-breakpoints"'));
        assert.ok(source.includes('href="#panel-stack"'));
        assert.ok(source.includes('id="debug-console"'));
        assert.ok(source.includes('id="panel-breakpoints"'));
        assert.ok(source.includes('id="panel-stack"'));
    });

    test('profiles nested RTA entry/exit events using exclusive runtime', () => {
        assert.ok(source.includes('function handleRtaEvent(m)'));
        assert.ok(source.includes('childTime: 0'));
        assert.ok(source.includes('duration - frame.childTime'));
        assert.ok(source.includes('totalExclusive'));
        assert.ok(source.includes('function rtaTsDiff(end, start)'));
        assert.ok(source.includes('0x100000000 - s + e'));
    });

    test('throttles rendering for high-rate trace streams', () => {
        assert.ok(source.includes('function scheduleRtaRender()'));
        assert.match(source, /setTimeout\(\(\) => \{[\s\S]*renderRtaProfiler\(\)[\s\S]*\}, 100\)/);
        assert.ok(!source.includes("add('rta', 'RTA: ' + dirIcon"));
    });

    test('clears live RUNNING state when RTA stops but keeps completed statistics', () => {
        assert.ok(source.includes('rtaStack.length = 0'));
        assert.ok(source.includes('keep completed statistics'));
        assert.ok(source.includes("const stateText = (rtaEnabled && active) ? 'RUNNING' : '—'"));
        assert.ok(!source.includes("(active ? 'ACTIVE' : 'IDLE')"));
    });

    test('classifies resolved runtime internals separately from app functions', () => {
        assert.ok(source.includes('function classifyRtaKind(name, kind, existingKind)'));
        assert.ok(source.includes("n.startsWith('usb.device.')"));
        assert.ok(source.includes("n.startsWith('trace_pump.')"));
        assert.ok(source.includes("kindLabel = p.kind === 'task'"));
        assert.ok(source.includes("'SYSTEM'"));
        assert.ok(source.includes("'UNKNOWN'"));
    });

    test('automatically resolves task and function names on RTA start', () => {
        assert.ok(source.includes('requestTaskMap();'));
        assert.ok(source.includes("JSON.stringify({ op: 'taskmap' })"));
        assert.ok(source.includes('msg.text.startsWith("taskmap=")'));
        assert.ok(source.includes("JSON.stringify({ op: 'tasks' })"));
        assert.ok(!source.includes('g=globals();exec("import sys,machine'));
        assert.ok(source.includes('requestSymbolMap();'));
        assert.ok(source.includes("__import__('trace_pump').get_symmap()"));
        assert.ok(source.includes("evt: 'rta_name'"));
        assert.ok(source.includes("existingKind === 'task'"));
        assert.ok(source.includes("op === 'rta_resolve_names'"));
    });

    test('accepts runtime function names but invalidates identities reused within a capture', () => {
        assert.ok(source.includes("msg.evt === 'rta_native_name'"));
        assert.ok(source.includes("m.evt === 'rta_native_name'"));
        assert.ok(source.includes('function setRtaNativeName(fun, name, bytecode, context)'));
        assert.ok(source.includes('previousIdentity !== undefined && previousIdentity !== identity'));
        assert.ok(source.includes('rtaNames.delete(key)'));
        assert.ok(source.includes('rtaNativeIdentity.clear()'));
        assert.ok(source.includes('funToName.clear()'));
        assert.ok(source.includes("name: '__rta_names_optin'"));
        assert.ok(source.includes("'rta_names_on'"));
        assert.ok(source.includes('funName.endsWith(\'.\' + liveSimpleName)'));
        assert.ok(source.includes("p.name + ' · fun=0x'"));
        assert.ok(source.includes('requestSymbolMap();')); // Existing fallback remains.
    });

    test('runtime identity change invalidates an old qualified name and task type', () => {
        const match = source.match(
            /(function setRtaNativeName\(fun, name, bytecode, context\) \{[\s\S]*?\n\})\n\nfunction getRtaProfile/
        );
        assert.ok(match, 'native function resolver is present');
        const rtaNames = new Map();
        const rtaNativeIdentity = new Map();
        const rtaProfiles = new Map();
        const rtaStack = [];
        const sandbox = {
            rtaNames,
            rtaNativeIdentity,
            rtaProfiles,
            rtaStack,
            setRtaName(fun, name, kind) {
                rtaNames.set(String(fun), { name, kind });
            }
        };
        const setRtaNativeName = vm.runInNewContext('(' + match[1] + ')', sandbox);

        const fn = 0x20001234;
        setRtaNativeName(fn, 'blink', 0x10001234, 0x20001000);
        assert.strictEqual(rtaNames.get(String(fn)).name, 'blink');

        // A qualified symbol or mapped asyncio name is retained when the
        // live function identity has not changed.
        rtaNames.set(String(fn), { name: 'main.blink', kind: 'task' });
        setRtaNativeName(fn, 'blink', 0x10001234, 0x20001000);
        assert.strictEqual(rtaNames.get(String(fn)).name, 'main.blink');
        assert.strictEqual(rtaNames.get(String(fn)).kind, 'task');

        // The same heap address can later hold a different function.
        // Old measurements and active frames must not follow the new name.
        rtaProfiles.set(String(fn), { name: 'main.blink', totalExclusive: 88 });
        rtaStack.push({ fun: fn, start: 100, childTime: 0 });
        setRtaNativeName(fn, 'worker', 0x10002000, 0x20001000);
        assert.strictEqual(rtaNames.get(String(fn)).name, 'worker');
        assert.strictEqual(rtaNames.get(String(fn)).kind, 'function');
        assert.strictEqual(rtaProfiles.has(String(fn)), false);
        assert.strictEqual(rtaStack.length, 0);
    });

    test('decodes optional firmware 0x07 names while preserving legacy RTA frames', () => {
        const bridge = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'dbg_bridge.py'),
            'utf8'
        );
        assert.ok(bridge.includes('t == 0x07 and not (13 <= n <= 72)'));
        assert.ok(bridge.includes('t in (0x05, 0x06) and n != 8'));
        assert.ok(bridge.includes('payload[12:].decode("utf-8")'));
        assert.ok(bridge.includes('say(evt="rta_native_name", fun=fun'));
    });

    test('uses firmware microsecond timestamps and does not claim exact CPU load', () => {
        assert.ok(source.includes("return us.toFixed(0) + ' µs'"));
        assert.ok(source.includes('Firmware timestamps are microseconds'));
        assert.ok(source.includes('It is not scheduler CPU%'));
        assert.ok(source.includes('Observed VM % is the share of completed MicroPython execution segments'));
    });
});
