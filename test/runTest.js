const path = require('path');

const { runTests } = require('@vscode/test-electron');

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '..');
        const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            version: process.env.MPS_TEST_VSCODE_VERSION || '1.105.1',
            launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
        });
    } catch (err) {
        console.error('Failed to run VS Code extension tests');
        console.error(err);
        process.exit(1);
    }
}

main();
