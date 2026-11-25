const path = require('path');
const fs = require('fs');

const Mocha = require('mocha');
const glob = require('glob');

function run() {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
    });

    const testsRoot = path.resolve(__dirname, '..');
    const files = glob.sync('**/*.test.js', {
        cwd: testsRoot,
        absolute: true,
        ignore: ['suite/**'],
    });

    files.forEach(file => mocha.addFile(file));

    return new Promise((resolve, reject) => {
        const results = [];
        const runner = mocha.run(failures => {
            if (process.env.MPS_QUALIFY_JS_RESULTS) {
                fs.writeFileSync(process.env.MPS_QUALIFY_JS_RESULTS, JSON.stringify(results), 'utf8');
            }
            if (failures > 0) {
                reject(new Error(`${failures} test(s) failed.`));
            } else {
                resolve();
            }
        });
        for (const status of ['pass', 'fail', 'pending']) {
            runner.on(status, (test, error) => {
                results.push({ file: test.file ? path.basename(test.file) : null,
                    title: test.fullTitle(), status,
                    error: error ? String(error.message || error) : '' });
            });
        }
    });
}

module.exports = { run };
