const assert = require('assert');
const path = require('path');
const fs = require('fs');

suite('Simple board-specific firmware downloads', () => {
    const root = path.resolve(__dirname, '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'src', 'debug_firmware.json'), 'utf8'));
    const source = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
    const dbg = fs.readFileSync(path.join(root, 'src', 'mpyDebugger.js'), 'utf8');

    test('the distribution repository is the only source of firmware downloads', () => {
        const repo = 'https://github.com/niwantha33/micropython_live_dbg_firmware';
        for (const id of ['pico', 'picow', 'pico2', 'pico2w', 'esp32-s3']) {
            const board = cfg.boards.find(x => x.id === id);
            assert.ok(board, id);
            assert.ok(board.download_page.startsWith(repo + '/'), id);
            if (board.download_url) {
                assert.ok(board.download_url.startsWith(repo + '/releases/download/'), id);
                assert.ok(!board.download_url.includes('/raw/refs/heads/'), id);
            }
        }
        for (const id of ['pico', 'pico2', 'pico2w', 'esp32-s3']) {
            const board = cfg.boards.find(x => x.id === id);
            assert.strictEqual(board.ready_for_release, false, id);
            assert.ok(!board.download_url, id);
        }
        const picow = cfg.boards.find(x => x.id === 'picow');
        assert.strictEqual(picow.ready_for_release, true);
        assert.ok(picow.download_url.endsWith('/micropython-studio-picow-debugger-v2.6.0.uf2'));
        for (const id of ['esp32-s2', 'esp32-c3']) {
            assert.ok(!cfg.boards.find(x => x.id === id).download_url);
        }
    });

    test('board picker distinguishes approved pinned releases from test pages without flashing', () => {
        assert.ok(source.includes('boards.filter(board =>'));
        assert.ok(source.includes('board.id !== \'esp32-c3\' && board.id !== \'esp32-s2\''));
        assert.ok(source.includes('board.ready_for_release === true'));
        assert.ok(source.includes("Download pinned release"));
        assert.ok(source.includes("View firmware repository"));
        assert.ok(source.includes("vscode.env.openExternal(uri)"));
        assert.ok(!source.includes('Open the latest workflow run and download only'));
        assert.ok(source.includes('Experimental debugger firmware for debugging and testing your own code ONLY. NOT FOR PRODUCTION USE.'));
        assert.ok(source.includes('Studio only opens the download and never flashes automatically.'));
        assert.ok(source.includes('Back up device files before any manual flashing.'));
    });

    test('Start Debug menu only offers Connect and Download firmware', () => {
        assert.ok(dbg.includes("label: '$(plug) Connect'"));
        assert.ok(dbg.includes("label: '$(cloud-download) Download firmware'"));
        assert.ok(!dbg.includes("description: 'Requires debugger-enabled firmware"));
        assert.ok(!dbg.includes('uploadDebuggerFiles('));
    });
});
