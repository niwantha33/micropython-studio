const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function gitValue(args) {
    try {
        return execFileSync('git', args, {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch (e) {
        return '';
    }
}

const commit = process.env.MICROPYTHON_STUDIO_COMMIT
    || process.env.GITHUB_SHA
    || gitValue(['rev-parse', 'HEAD'])
    || 'unknown';

const info = {
    version: pkg.version,
    buildDate: process.env.MICROPYTHON_STUDIO_BUILD_DATE || new Date().toISOString(),
    commit,
    commitShort: commit !== 'unknown' ? commit.slice(0, 10) : 'unknown'
};

const out = path.join(root, 'src', 'build_info.json');
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log(`MicroPython Studio build info: v${info.version} ${info.commitShort} ${info.buildDate}`);
