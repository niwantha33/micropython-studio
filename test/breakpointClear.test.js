const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Breakpoint clear regression', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
        'utf8'
    );

    test('new debugger session clears stale target slots before installing IDE breakpoints', () => {
        const pump = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'debugger_files', 'trace_pump.py'),
            'utf8'
        );
        const bridge = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'dbg_bridge.py'),
            'utf8'
        );
        assert.ok(source.includes("op: 'clear_all_bp'"));
        assert.ok(source.indexOf("op: 'clear_all_bp'") < source.indexOf('// Send existing breakpoints'));
        assert.ok(bridge.includes('"clear_all_bp": 0x1D'));
        assert.ok(pump.includes('active = dbg.list_bp()'));
        assert.ok(pump.includes('dbg.clear_bp(slot)'));
        assert.ok(pump.includes('cleared all bp slots'));
    });

    test('removed breakpoint cancels a pending device registration', () => {
        assert.ok(
            source.includes('pending.cancelled = true'),
            'removal must mark pending set requests as cancelled'
        );
        assert.ok(
            source.includes('if (info.cancelled)'),
            'late set replies must detect cancelled breakpoints'
        );
        assert.match(
            source,
            /if \(info\.cancelled\)[\s\S]*op: 'clear_bp', slot/,
            'late device slots must be cleared immediately'
        );
    });

    test('removal clears every registered slot for the source breakpoint', () => {
        assert.ok(
            source.includes('key "module:func:line" -> Set<slot>'),
            'breakpoint map must retain all target slots for a source location'
        );
        assert.match(
            source,
            /for \(const slot of slots\)[\s\S]*op: 'clear_bp', slot/,
            'all known slots must be sent to clear_bp'
        );
        assert.ok(
            source.includes('for (const key of keysToClear)'),
            'removal must process every matching breakpoint key'
        );
    });
});
