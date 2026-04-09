// scripts/index-circuitpython-html.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');  // npm install jsdom

async function extractHtmlText(htmlPath) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract main content (adjust selector based on actual docs structure)
    const main = doc.querySelector('main') || doc.querySelector('article') || doc.body;
    return main.textContent.replace(/\s+/g, ' ').trim();
}

// Reuse chunkText and extractKeywords from previous script...

async function buildIndex(htmlPath, outputPath) {
    console.log(`🌐 Indexing HTML docs: ${htmlPath}`);
    const text = await extractHtmlText(htmlPath);
    // ... same chunking logic as PDF version
}

if (require.main === module) {
    const htmlPath = process.argv[2] || './temp-docs/index.html';
    const outputPath = process.argv[3] || './resource/circuitpython-index.json';
    buildIndex(htmlPath, outputPath).catch(console.error);
}