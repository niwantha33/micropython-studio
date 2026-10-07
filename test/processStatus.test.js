const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Process status reporting', () => {
    test('does not report failed backend tasks as success', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'extension.js'), 'utf8');
        assert.ok(source.includes('if (code === 0) {'));
        assert.ok(source.includes('[SUCCESS] Task complete.'));
        assert.ok(source.includes('[ERROR] Task failed with exit code ${code}.'));
    });
});
