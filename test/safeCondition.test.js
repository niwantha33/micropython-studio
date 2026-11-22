'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { evaluateCondition, parseDeviceLiteral, compileCondition } = require('../src/safeCondition');

suite('Safe conditional breakpoint interpreter', () => {
    test('parses MicroPython scalar repr without executing device text', () => {
        assert.strictEqual(parseDeviceLiteral('True'), true);
        assert.strictEqual(parseDeviceLiteral('None'), null);
        assert.strictEqual(parseDeviceLiteral('-2.5e2'), -250);
        assert.strictEqual(parseDeviceLiteral("'hello\\nworld'"), 'hello\nworld');
        assert.strictEqual(parseDeviceLiteral('"abc"'), 'abc');
        assert.strictEqual(parseDeviceLiteral('0x10'), 16);
        const malicious = "({constructor:{constructor:'return process'}})";
        assert.strictEqual(parseDeviceLiteral(malicious), malicious);
    });
    test('supports ordinary conditions and Python boolean precedence', () => {
        const vars = { count: 7, temp: 24.5, enabled: true, label: 'sensor', empty: null };
        assert.strictEqual(evaluateCondition('count > 5 and enabled', vars), true);
        assert.strictEqual(evaluateCondition('count < 5 or not enabled', vars), false);
        assert.strictEqual(evaluateCondition('(count + 3) * 2 == 20', vars), true);
        assert.strictEqual(evaluateCondition("label == 'sensor' and empty is None", vars), true);
        assert.strictEqual(evaluateCondition('True and False or not False'), true);
        assert.strictEqual(evaluateCondition("count in '7,8,9'", vars), true);
    });
    test('rejects code execution, attribute access and calls', () => {
        const vars = { count: 7 };
        const payloads = [
            'process.exit(1)',
            'count.constructor.constructor("return process")()',
            '__proto__',
            "count || require('fs').writeFileSync('pwned', '1')",
            "count;require('child_process')",
            "[1,2,3]",
            'count.__class__',
            'count[0]',
            "count == 7 # comment",
            'Math.max(1, 2)'
        ];
        for (const payload of payloads) {
            assert.throws(() => evaluateCondition(payload, vars), Error, payload);
        }
    });
    test('bounds token count, length, and depth', () => {
        assert.throws(() => compileCondition('x'.repeat(1025)), /length/);
        assert.throws(() => compileCondition('not '.repeat(270) + 'True'), /length|tokens/);
        assert.throws(() => compileCondition('('.repeat(40) + 'True' + ')'.repeat(40)), /nesting/);
    });
    test('debugger code must not invoke host eval or Function()', () => {
        const debuggerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');
        assert.ok(debuggerSource.includes('evaluateCondition(pe.cond, args)'));
        assert.ok(debuggerSource.includes('parseDeviceLiteral('));
        assert.ok(!/\beval\s*\(/.test(debuggerSource));
        assert.ok(!/\bnew\s+Function\s*\(/.test(debuggerSource));
    });
});