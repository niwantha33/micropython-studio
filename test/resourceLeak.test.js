const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Resource leak regression', () => {
    test('wsQueue reuses one output channel instead of opening one per log line', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'wsQueue.js'), 'utf8');
        assert.ok(source.includes('let logChannel = null;'));
        assert.ok(source.includes('function getLogChannel()'));
        assert.ok(source.includes('getLogChannel().appendLine(msg)'));
        const creates = source.match(/createOutputChannel\('MicroPython IDE'\)/g) || [];
        assert.strictEqual(creates.length, 1);
    });

    test('debugger setup output channel is reused across upload attempts', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');
        assert.ok(source.includes('let debugSetupOutputChannel = null;'));
        assert.ok(source.includes('function getDebugSetupOutputChannel()'));
        assert.ok(source.includes('const out = getDebugSetupOutputChannel();'));
        const creates = source.match(/createOutputChannel\('MPy Debugger Setup'\)/g) || [];
        assert.strictEqual(creates.length, 1);
    });
});
