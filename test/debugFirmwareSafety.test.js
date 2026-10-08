const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Debug firmware release safety', () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'debug_firmware.json'), 'utf8'));
    const ext = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'extension.js'), 'utf8');
    const dbg = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');

    test('unvalidated frozen candidates are never marked released', () => {
        assert.strictEqual(cfg.rta_certified, false);
        assert.strictEqual(cfg.rta_certified_source_commit, null);
        assert.ok(cfg.boards.every(b => b.ready_for_release === false));
        assert.ok(cfg.boards.filter(b => b.artifact_name).every(b => b.artifact_name.endsWith('-UNVALIDATED')));
    });
    test('S3 points to test builds, not April 2026 legacy firmware', () => {
        assert.ok(!JSON.stringify(cfg).includes('ESP32S3/firmware.bin'));
        assert.ok(cfg.boards.find(b => b.id === 'esp32-s3').download_page.includes('weekly-candidate-builds.yml'));
    });
    test('download guide does not silently flash unvalidated firmware', () => {
        assert.ok(ext.includes('vscode.env.openExternal(uri)'));
        assert.ok(ext.includes("artifact_name"));
        assert.ok(ext.includes('UNVALIDATED TEST BUILD'));
        assert.ok(!dbg.includes('uploadDebuggerFiles'));
    });
});
