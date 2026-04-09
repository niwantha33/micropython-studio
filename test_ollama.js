// Save as test-ollama.js in your project root
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

async function test() {
    const modelfilePath = path.join(__dirname, 'resource', 'Modelfile-mpy');
    let content = fs.readFileSync(modelfilePath, 'utf-8').trim();
    
    // Normalize & fix SYSTEM format (same as in main code)
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    content = content.replace(/SYSTEM\s*"""\s*\n([\s\S]*?)\n\s*"""/g, (m, p1) => {
        return `SYSTEM "${p1.trim().replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
    });

    console.log('📤 Sending to Ollama:');
    console.log(content.split('\n').slice(0, 5).join('\n'));

    const res = await fetch('http://127.0.0.1:11434/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'debug-test-mpy', modelfile: content })
    });

    const text = await res.text();
    console.log(`📥 Response [${res.status}]:`, text);
    
    if (res.ok) {
        console.log('✅ Success! You can now delete the test model:');
        console.log('   ollama rm debug-test-mpy');
    }
}

test().catch(console.error);