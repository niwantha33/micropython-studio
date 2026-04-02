const https = require('https');

function _fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: { 'User-Agent': 'MicroPython-Studio-VSCode' }
        };
        https.get(url, options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return _fetchJSON(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch ${url}: Status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function test() {
    const repos = [
        'adafruit/Adafruit_CircuitPython_Bundle',
        'adafruit/CircuitPython_Community_Bundle'
    ];
    
    for (const repo of repos) {
        console.log(`\n--- Fetching ${repo} ---`);
        try {
            const release = await _fetchJSON(`https://api.github.com/repos/${repo}/releases/latest`);
            console.log(`Latest release: ${release.tag_name}`);
            const asset = release.assets.find(a => a.name.endsWith('.json') && !a.name.includes('version'));
            if (asset) {
                console.log(`Found asset: ${asset.name}`);
                const indexData = await _fetchJSON(asset.browser_download_url);
                const keys = Object.keys(indexData);
                console.log(`Success! Found ${keys.length} libraries.`);
                console.log(`Sample: ${keys.slice(0, 5).join(', ')}`);
            }
        } catch (err) {
            console.error(`Error: ${err.message}`);
        }
    }
}

test();
