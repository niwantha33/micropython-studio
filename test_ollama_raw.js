// test-fetch-create.js - Uses node-fetch like your extension does
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

async function test() {
    const baseUrl = 'http://127.0.0.1:11434';
    
    // Test 1: Minimal with trailing newline
    console.log('🧪 TEST 1: Minimal Modelfile via node-fetch');
    const minimal = 'FROM qwen2.5-coder:3b\n';
    
    try {
        const res = await fetch(`${baseUrl}/api/create`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json; charset=utf-8',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ name: 'fetch-test-min', modelfile: minimal })
        });
        
        const text = await res.text();
        console.log(`📥 Response [${res.status}]:`, text);
        
        if (res.ok) {
            console.log('✅ fetch-test-min created! Clean up: ollama rm fetch-test-min');
        } else {
            console.log('❌ Minimal test failed via fetch too');
        }
    } catch (e) {
        console.error('❌ Fetch error:', e.message);
    }

    // Test 2: Your actual Modelfile
    console.log('\n🧪 TEST 2: Actual Modelfile-mpy via node-fetch');
    const mpyPath = path.join(__dirname, 'resource', 'Modelfile-mpy');
    let content = fs.readFileSync(mpyPath, 'utf-8')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim() + '\n';  // Ensure trailing newline
    
    try {
        const res = await fetch(`${baseUrl}/api/create`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json; charset=utf-8',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ name: 'fetch-test-mpy', modelfile: content })
        });
        
        const text = await res.text();
        console.log(`📥 Response [${res.status}]:`, text);
        
        if (res.ok) {
            console.log('✅ fetch-test-mpy created! Clean up: ollama rm fetch-test-mpy');
        }
    } catch (e) {
        console.error('❌ Fetch error:', e.message);
    }
}

test().catch(console.error);