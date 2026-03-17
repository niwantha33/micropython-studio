const { runMpremote } = require('./src/runCommand');
const outputChannel = { appendLine: console.log, append: console.log };

async function test() {
    try {
        const sysSnippet = `import sys; print(sys.implementation.name); print(sys.implementation.version);`;
        // test how runMpremote handles it
        const result = await runMpremote(outputChannel, ['exec', `"${sysSnippet}"`]);
        console.log("---- RAW RESULT ----")
        console.log(result);
    } catch(e) {
        console.error(e);
    }
}
test();
