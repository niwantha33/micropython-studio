const assert = require('assert');
const path = require('path');
const fs = require('fs');

suite('Simple board-specific firmware downloads', () => {
    const root = path.resolve(__dirname, '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'src', 'debug_firmware.json'), 'utf8'));
    const source = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
    const dbg = fs.readFileSync(path.join(root, 'src', 'mpyDebugger.js'), 'utf8');

    test('five candidate boards have direct, exact-model firmware files', () => {
        const expected = {
            pico: 'TestBuilds/Pico/firmware_pico.uf2',
            picow: 'TestBuilds/Picow/firmware_pico_w.uf2',
            pico2: 'TestBuilds/Pico2/firmware_pico2.uf2',
            pico2w: 'TestBuilds/Pico2w/firmware_pico2_w.uf2',
            'esp32-s3': 'TestBuilds/ESP32S3/firmware_esp32s3.bin',
        };
        for (const [id, suffix] of Object.entries(expected)) {
            const board = cfg.boards.find(x => x.id === id);
            assert.ok(board, id);
            assert.ok(board.download_url.endsWith(suffix), id);
            assert.strictEqual(board.ready_for_release, false);
        }
        for (const id of ['esp32-s2', 'esp32-c3']) {
            assert.ok(!cfg.boards.find(x => x.id === id).download_url);
        }
    });

    test('board picker shows only available boards, without clutter or flashing', () => {
        assert.ok(source.includes('boards.filter(board => typeof board.download_url'));
        assert.ok(source.includes('label: board.label, board'));
        assert.ok(source.includes("placeHolder: 'Select your board'"));
        assert.ok(source.includes("answer === 'Download' ? board.download_url : board.download_page"));
        assert.ok(!source.includes('Open the latest workflow run and download only'));
        assert.ok(!source.includes("description: board.ready_for_release"));
        assert.ok(source.includes('Experimental debugger firmware for debugging and testing your own code ONLY. NOT FOR PRODUCTION USE.'));
        assert.ok(source.includes('Download only opens the firmware file; Studio does not flash it.'));
        assert.ok(source.includes('Back up your device files before flashing.'));
    });

    test('Start Debug menu only offers Connect and Download firmware', () => {
        assert.ok(dbg.includes("label: '$(plug) Connect'"));
        assert.ok(dbg.includes("label: '$(cloud-download) Download firmware'"));
        assert.ok(!dbg.includes("description: 'Requires debugger-enabled firmware"));
        assert.ok(!dbg.includes('uploadDebuggerFiles('));
    });
});
