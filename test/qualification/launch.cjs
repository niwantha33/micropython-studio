// Developer-only cross-platform Python launcher.
const { spawnSync } = require('child_process');
const candidates = process.env.MPS_QUALIFY_PYTHON
    ? [[process.env.MPS_QUALIFY_PYTHON]]
    : process.platform === 'win32' ? [['python'], ['py', '-3']] : [['python3'], ['python']];
for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, 'test/qualification/qualify.py', ...process.argv.slice(2)],
        { stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') continue;
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
}
console.error('Python 3 is required for qualification.');
process.exit(1);
