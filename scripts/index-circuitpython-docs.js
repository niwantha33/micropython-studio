// scripts/index-circuitpython-docs.js (pdfjs-dist version)
const fs = require('fs');
const path = require('path');

// ✅ Use pdfjs-dist (Mozilla's PDF.js)
const pdfjsLib = require('pdfjs-dist');

// Set worker source (required for Node.js)
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/build/pdf.worker.js');

async function extractPdfText(pdfPath) {
    console.log(`📄 Reading PDF: ${pdfPath}`);

    if (!fs.existsSync(pdfPath)) {
        throw new Error(`PDF not found: ${pdfPath}`);
    }

    const dataBuffer = fs.readFileSync(pdfPath);
    const loadingTask = pdfjsLib.getDocument({ data: dataBuffer });
    const pdf = await loadingTask.promise;

    let fullText = '';

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += pageText + '\n';

        if (pageNum % 20 === 0) {
            console.log(`   📄 Processed ${pageNum}/${pdf.numPages} pages...`);
        }
    }

    console.log(`✅ Extracted ${pdf.numPages} pages, ${fullText.length} chars`);
    return fullText;
}

function chunkText(text, chunkSize = 800, overlap = 100) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
        let end = Math.min(start + chunkSize, text.length);

        if (end < text.length) {
            const breakPoints = [
                text.lastIndexOf('\n\n', end),
                text.lastIndexOf('\n', end),
                text.lastIndexOf('. ', end),
                text.lastIndexOf(', ', end)
            ].filter(p => p > start + chunkSize * 0.5);

            if (breakPoints.length > 0) {
                end = Math.max(...breakPoints) + 1;
            }
        }

        const chunk = text.substring(start, end).trim();
        if (chunk.length > 50) {
            chunks.push(chunk);
        }

        start = end - overlap;
        if (start < 0) start = 0;
        if (start >= text.length) break;
    }

    return chunks;
}

function extractKeywords(text, maxWords = 50) {
    const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'has', 'are', 'was', 'were', 'been', 'be', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'must', 'need', 'get', 'got', 'make', 'made', 'take', 'took', 'come', 'came', 'go', 'went', 'know', 'knew', 'see', 'saw', 'look', 'looks', 'use', 'used', 'using', 'find', 'found', 'give', 'gave', 'work', 'works', 'call', 'called', 'try', 'tried', 'ask', 'asked', 'feel', 'felt', 'become', 'became', 'leave', 'left', 'put', 'puts', 'mean', 'meant', 'keep', 'kept', 'let', 'lets', 'begin', 'began', 'seem', 'seemed', 'help', 'helped', 'show', 'showed', 'shown', 'hear', 'heard', 'run', 'ran', 'move', 'moved', 'live', 'lived', 'believe', 'believed', 'bring', 'brought', 'happen', 'happened', 'write', 'wrote', 'written', 'sit', 'sat', 'stand', 'stood', 'lose', 'lost', 'pay', 'paid', 'meet', 'met', 'include', 'included', 'continue', 'continued', 'set', 'sets', 'learn', 'learned', 'change', 'changed', 'lead', 'led', 'understand', 'understood', 'watch', 'watched', 'follow', 'followed', 'stop', 'stopped', 'create', 'created', 'speak', 'spoke', 'spoken', 'read', 'reads', 'allow', 'allowed', 'add', 'added', 'spend', 'spent', 'grow', 'grew', 'grown', 'open', 'opened', 'walk', 'walked', 'win', 'won', 'offer', 'offered', 'remember', 'remembered', 'love', 'loved', 'consider', 'considered', 'appear', 'appeared', 'buy', 'bought', 'wait', 'waited', 'serve', 'served', 'die', 'died', 'send', 'sent', 'expect', 'expected', 'build', 'built', 'stay', 'stayed', 'fall', 'fell', 'fallen', 'cut', 'cuts', 'reach', 'reached', 'kill', 'killed', 'remain', 'remained']);

    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w))
        .slice(0, maxWords);
}

async function buildIndex(pdfPath, outputPath) {
    console.log(`🚀 Starting CircuitPython docs indexing...`);
    console.log(`📄 Input: ${pdfPath}`);
    console.log(`📁 Output: ${outputPath}`);

    const fullText = await extractPdfText(pdfPath);

    console.log(`✂️ Chunking text (800 chars, 100 overlap)...`);
    const chunks = chunkText(fullText, 800, 100);
    console.log(`✅ Created ${chunks.length} chunks`);

    console.log(`🔑 Extracting keywords...`);
    const index = chunks.map((chunk, i) => ({
        id: i,
        text: chunk,
        keywords: extractKeywords(chunk, 50),
        preview: chunk.substring(0, 100).replace(/\n/g, ' ')
    }));

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(index, null, 2), 'utf8');

    console.log(`🎉 Indexing complete!`);
    console.log(`📊 Stats:`);
    console.log(`   - Total chunks: ${index.length}`);
    console.log(`   - Avg chunk size: ${Math.round(index.reduce((sum, c) => sum + c.text.length, 0) / index.length)} chars`);
    console.log(`   - Output file: ${outputPath} (${Math.round(fs.statSync(outputPath).size / 1024)} KB)`);
}

if (require.main === module) {
    const pdfPath = process.argv[2] || './circuitpython-docs.pdf';
    const outputPath = process.argv[3] || './resource/circuitpython-index.json';

    buildIndex(pdfPath, outputPath)
        .then(() => console.log('\n✅ Done!'))
        .catch(err => {
            console.error('\n❌ Fatal error:', err.message);
            console.error(err.stack);
            process.exit(1);
        });
}

module.exports = { buildIndex, extractPdfText, chunkText };