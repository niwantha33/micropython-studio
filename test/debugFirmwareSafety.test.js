const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Debug firmware release safety', () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'debug_firmware.json'), 'utf8'));
    const ext = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'extension.js'), 'utf8');
    const dbg = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');

    test('stable firmware channel is explicitly not RTA-certified before hardware release', () => {
        assert.strictEqual(cfg.rta_certified, false);
        assert.strictEqual(cfg.rta_certified_source_commit, null);
    });

    test('debugger RTA firmware action requests an RTA-certified build', () => {
        assert.ok(dbg.includes("requireRta: rtaSupported === false"));
        assert.ok(dbg.includes("source: 'debugger'"));
    });

    test('stable flash command refuses uncertified firmware for RTA', () => {
        assert.ok(ext.includes("if (options.requireRta && !RTA_CERTIFIED)"));
        assert.ok(ext.includes('No firmware was flashed.'));
        assert.ok(ext.includes('hardware-test Pico 2 W UF2 from firmware PR #1'));
    });
});
