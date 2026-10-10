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
        assert.ok(cfg.boards.every(b => b.ready_for_release === true
            ? b.download_url && b.download_url.includes('/releases/download/')
            : !b.download_url));
        assert.ok(cfg.boards.filter(b => b.artifact_name).every(b => b.artifact_name.endsWith('-UNVALIDATED')));
    });
    test('ESP32-S3 opens the pinned preview instructions, not a mutable binary', () => {
        assert.ok(!JSON.stringify(cfg).includes('ESP32S3/firmware.bin'));
        const s3 = cfg.boards.find(b => b.id === 'esp32-s3');
        assert.ok(s3.download_page.endsWith('/releases/tag/v2.6.0-esp32s3-preview'));
        assert.strictEqual(s3.ready_for_release, false);
        assert.strictEqual(s3.download_url, null);
    });
    test('all Pico and ESP32-S3 firmware links use only the distribution repository', () => {
        const root = 'https://github.com/niwantha33/micropython_live_dbg_firmware';
        for (const b of cfg.boards) {
            assert.ok(b.download_page === root || b.download_page.startsWith(root + '/'), b.id);
            if (b.download_url) {
                assert.ok(b.download_url.startsWith(root + '/releases/download/'), b.id);
                assert.ok(!b.download_url.includes('/raw/refs/heads/'), b.id);
            }
        }
        const stablePicoW = cfg.boards.find(b => b.id === 'picow');
        assert.strictEqual(stablePicoW.ready_for_release, true);
        assert.ok(stablePicoW.download_url.endsWith('micropython-studio-picow-debugger-v2.6.0.uf2'));
        for (const id of ['pico', 'pico2', 'pico2w']) {
            const b = cfg.boards.find(x => x.id === id);
            assert.ok(b.download_page.includes('/tree/main/TestBuilds/'), id);
            assert.strictEqual(b.download_url, null, id);
        }
    });
    test('download guide does not silently flash unvalidated firmware', () => {
        assert.ok(ext.includes('vscode.env.openExternal(uri)'));
        assert.ok(ext.includes("board.download_url"));
        assert.ok(ext.includes("board.ready_for_release === true"));
        assert.ok(ext.includes("'Download pinned release'"));
        assert.ok(ext.includes("'View firmware repository'"));
        assert.ok(ext.includes('Experimental debugger firmware for debugging and testing your own code ONLY. NOT FOR PRODUCTION USE.'));
        assert.ok(!dbg.includes('uploadDebuggerFiles'));
    });
});
