const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Process status reporting', () => {
    test('only reports successful backend tasks for exit code zero', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'extension.js'), 'utf8');
        assert.ok(source.includes("channel.appendLine(code === 0 ? '[SUCCESS] Task complete.'"));
        assert.ok(source.includes("code === null ? ' (connection or process error)'"));
        assert.ok(source.includes("channel.appendLine(`[ERROR] Cannot claim serial port:"));
        assert.ok(source.includes("if (onComplete) onComplete(code);"));
    });
});
