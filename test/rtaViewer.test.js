const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

    test('uses firmware microsecond timestamps and does not claim exact CPU load', () => {
        assert.ok(source.includes("return us.toFixed(0) + ' µs'"));
        assert.ok(source.includes('Firmware timestamps are microseconds'));
        assert.ok(source.includes('It is not scheduler CPU%'));
        assert.ok(source.includes('Observed VM % is the share of completed MicroPython execution segments'));
    });
});
