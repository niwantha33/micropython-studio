const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function gitValue(extensionPath, args) {
    try {
        return execFileSync('git', args, {
            cwd: extensionPath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch (e) {
        return '';
    }
}

function getBuildInfo(extensionPath, extensionMode) {
    const packageJson = readJson(path.join(extensionPath, 'package.json')) || {};
    const embedded = readJson(path.join(extensionPath, 'src', 'build_info.json')) || {};
    const isDevelopment = extensionMode === 2; // vscode.ExtensionMode.Development

    if (isDevelopment) {
        const commit = gitValue(extensionPath, ['rev-parse', 'HEAD']) || embedded.commit || 'unknown';
        const commitDate = gitValue(extensionPath, ['show', '-s', '--format=%cI', 'HEAD']);
        return {
            version: packageJson.version || embedded.version || '0.0.0',
            buildDate: commitDate || embedded.buildDate || 'development',
            commit,
            commitShort: commit !== 'unknown' ? commit.slice(0, 10) : 'unknown',
            mode: 'development'
        };
    }

    const commit = embedded.commit || 'unknown';
    return {
        version: embedded.version || packageJson.version || '0.0.0',
        buildDate: embedded.buildDate || 'unknown',
        commit,
        commitShort: embedded.commitShort || (commit !== 'unknown' ? commit.slice(0, 10) : 'unknown'),
        mode: 'packaged'
    };
}

module.exports = { getBuildInfo };
