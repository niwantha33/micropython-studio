const path = require('path');

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
        mocha.run(failures => {
            if (failures > 0) {
                reject(new Error(`${failures} test(s) failed.`));
            } else {
                resolve();
            }
        });
    });
}

module.exports = { run };
