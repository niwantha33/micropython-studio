const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Breakpoint clear regression', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
        'utf8'
    );

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
