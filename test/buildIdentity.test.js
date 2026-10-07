const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Debugger console and build identity', () => {
    const debuggerSource = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
        'utf8'
    );
    const packageJson = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '..', 'package.json'),
        'utf8'
    ));

    test('locals and globals panel replies are not duplicated in the debug console', () => {
        assert.ok(
            debuggerSource.includes('/^depth=\\d+\\s+(?:state=\\[|globals=\\{)/'),
            'structured locals/globals replies must be identified'
        );
        assert.match(
            debuggerSource,
            /if \(!isPanelDataReply\) \{\s*add\('reply', 'REPLY  ' \+ m\.text\);/,
            'only non-panel replies should be written to the console'
        );
        assert.ok(
            debuggerSource.includes('const globIdx = m.text.indexOf("globals={")'),
            'globals replies must still populate the Globals panel'
        );
    });

    test('debugger header shows version, build date and commit identity', () => {
        assert.ok(debuggerSource.includes('Studio v${safeVersion}'));
        assert.ok(debuggerSource.includes('Build ${safeBuildDate}'));
        assert.ok(debuggerSource.includes('Commit ${safeCommit}'));
        assert.ok(debuggerSource.includes("require('./buildInfo')"));
    });

    test('VSIX packaging generates embedded build metadata', () => {
        assert.strictEqual(
            packageJson.scripts['vscode:prepublish'],
            'node scripts/generate-build-info.js'
        );
        const generator = fs.readFileSync(
            path.resolve(__dirname, '..', 'scripts', 'generate-build-info.js'),
            'utf8'
        );
        assert.ok(generator.includes('GITHUB_SHA'));
        assert.ok(generator.includes('new Date().toISOString()'));
        assert.ok(generator.includes("src', 'build_info.json"));
    });
});
