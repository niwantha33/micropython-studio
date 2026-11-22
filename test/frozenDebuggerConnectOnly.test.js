const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Firmware-first debugger workflow', () => {
    const dbg = fs.readFileSync(path.join(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');
    const ext = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');

    test('start debugger exposes connect and firmware help, never uploads Python files', () => {
        assert.ok(dbg.includes("id: 'connect'"));
        assert.ok(dbg.includes("id: 'firmware'"));
        assert.ok(!dbg.includes('uploadDebuggerFiles('));
        assert.ok(!dbg.includes('verifyUploadedPumpFile('));
        assert.ok(!dbg.includes("id: 'upload'"));
        assert.ok(dbg.includes("micropython-ide.flashDebugFirmware"));
    });
    test('REPL port and debugger port must be different', () => {
        const settings = fs.readFileSync(path.join(__dirname, '..', 'src', 'debugAdapterSettings.js'), 'utf8');
        assert.ok(dbg.includes("chooseDebugAdapter(normalizeSerialPort(replPort))"));
        assert.ok(settings.includes("samePort(candidate, repl)"));
        assert.ok(settings.includes("Debugger COM and USB REPL COM must be different"));
    });
    test('firmware command navigates only, never flashes or overwrites boot.py', () => {
        assert.ok(ext.includes("board.download_url"));
        assert.ok(ext.includes("vscode.env.openExternal(uri)"));
        assert.ok(ext.includes('Experimental debugger firmware for debugging and testing your own code ONLY. NOT FOR PRODUCTION USE.'));
        assert.ok(!ext.includes("Firmware flashed. Pico is rebooting."));
        assert.ok(!dbg.includes("'--overwrite'"));
    });
});
