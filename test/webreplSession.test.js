const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSessionWebReplScript, parseSessionWebReplResult } = require('../src/webreplSession');

suite('WebREPL session-only dashboard startup', () => {
    test('start script reuses connected WLAN without writing device files', () => {
        const script = buildSessionWebReplScript('hidden-test-password');
        assert.ok(script.includes('network.WLAN(network.STA_IF)'));
        assert.ok(script.includes('webrepl.start(password='));
        assert.ok(script.includes('MPS_WEBREPL_OK|'));
        assert.ok(!script.includes('boot.py'));
        assert.ok(!script.includes('webrepl_cfg.py'));
        assert.ok(!script.includes('open('));
    });
    test('parses success through unrelated REPL output', () => {
        assert.strictEqual(parseSessionWebReplResult('>>>\r\nMPS_WEBREPL_OK|10.20.100.198\r\n'), '10.20.100.198');
    });
    test('reports actual Python exceptions and incomplete output', () => {
        assert.throws(
            () => parseSessionWebReplResult('MPS_WEBREPL_ERROR|OSError: no network interface'),
            /no network interface/
        );
        assert.throws(() => parseSessionWebReplResult('>>>'), /did not confirm startup/);
        assert.throws(() => parseSessionWebReplResult('MPS_WEBREPL_OK|999.1.1.1'), /invalid IPv4/);
    });
    test('checks password length before executing code', () => {
        assert.throws(() => buildSessionWebReplScript('abc'), /4–64/);
        assert.throws(() => buildSessionWebReplScript('x'.repeat(65)), /4–64/);
    });
    test('uses active REPL daemon and no boot.py overwrite in dashboard', () => {
        const dash = fs.readFileSync(path.join(__dirname,'..','src','deviceDashboard.js'),'utf8');
        assert.ok(dash.includes('manager.runCodeSilently(code)'));
        assert.ok(dash.includes('parseSessionWebReplResult(raw)'));
        assert.ok(dash.includes('command: "webReplError"'));
        assert.ok(dash.includes("if (msg.command === 'webReplError')"));
        assert.ok(dash.includes('Session only — boot.py unchanged'));
        assert.ok(!dash.includes("with open('boot.py', 'w')"));
        assert.ok(!dash.includes('micro123'));
    });
    test('does not print passwords in configuration logs', () => {
        const cfg = fs.readFileSync(path.join(__dirname,'..','src','commonFxn.js'),'utf8');
        assert.ok(cfg.includes('[REDACTED]'));
        assert.ok(cfg.includes('const displayValue = /password|secret|token|api')); 
        assert.ok(cfg.includes('console.log(`Updated ${key} in [${section}] to "${displayValue}"`)'));
    });
});
