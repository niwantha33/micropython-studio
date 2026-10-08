'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const published = path.join(root, 'docs');
const publishedPages = [
    'index.html', 'getting-started.html', 'board-support.html',
    'troubleshooting.html', 'micropython-live-debugger.html'
];
const publishedAssets = [
    ...publishedPages, 'site-docs.css', 'robots.txt', 'sitemap.xml'
];
const content = (name) => fs.readFileSync(path.join(published, name), 'utf8');

suite('GitHub Pages public documentation', () => {
    test('every resource is present in the actual docs/ publishing directory', () => {
        for (const name of publishedAssets) {
            assert.ok(fs.existsSync(path.join(published, name)), name + ' missing from GitHub Pages source');
            assert.strictEqual(content(name), fs.readFileSync(path.join(root, name), 'utf8'), name + ' drifted from root copy');
        }
    });

    test('all new landing pages have a title, canonical URL and accessible main content', () => {
        for (const name of publishedPages.filter(x => x !== 'index.html')) {
            const page = content(name);
            assert.match(page, /<html lang="en">/i, name);
            assert.match(page, /<title>[^<]+<\/title>/i, name);
            assert.match(page, /<link rel="canonical" href="https:\/\/niwantha33.github.io\/micropython-studio\//, name);
            assert.match(page, /<main(?:\s|>)/, name);
            assert.match(page, /href="#main"/, name);
        }
    });

    test('all relative HTML and stylesheet links resolve within the deployed site', () => {
        for (const name of publishedPages) {
            const page = content(name);
            for (const [, href] of page.matchAll(/href=["'](\.\/[^"'#?]*)["']/g)) {
                const resolved = path.resolve(published, href === './' ? 'index.html' : href);
                assert.ok(resolved.startsWith(published + path.sep),
                    'Link escapes published root: ' + name + ' -> ' + href);
                assert.ok(fs.existsSync(resolved),
                    'Broken relative link: ' + name + ' -> ' + href);
            }
        }
    });

    test('home page has a working Docs destination and does not claim all Pico debugger firmware is validated', () => {
        const home = content('index.html');
        assert.ok(home.includes('["Docs", "./getting-started.html"]'));
        assert.ok(home.includes('aria-label="Help and downloads"'));
        assert.ok(home.includes('Debugger firmware varies by board'));
        assert.ok(!home.includes('All Picos Supported'));
        assert.ok(!home.includes('The only debugger that shows actual bytecode position.'));
    });

    test('board page lists stable Pico W, preview S3 and unapproved candidates separately', () => {
        const page = content('board-support.html');
        assert.ok(page.includes('Stable hardware-tested v2.6.0'));
        assert.ok(page.includes('Existing live-debugger workflow hardware exercised'));
        assert.ok(page.includes('Preview, not stable'));
        assert.ok(page.includes('No released dual-transport debugger firmware'));
        assert.ok(page.includes('micropython-studio-picow-debugger-v2.6.0.uf2'));
        assert.ok(page.includes('releases/tag/v2.6.0-esp32s3-preview'));
    });

    test('troubleshooting avoids destructive boot.py advice and separates TCP reachability from login', () => {
        const help = content('troubleshooting.html');
        assert.ok(help.includes('Test-NetConnection'));
        assert.ok(help.includes('TCP connection'));
        assert.ok(help.includes('correct WebREPL password'));
        assert.ok(help.includes('Do not remove that safeguard'));
        assert.ok(help.includes('without touching flash'));
    });

    test('published sitemap contains all five public pages and the correct base URL', () => {
        const xml = content('sitemap.xml');
        for (const name of publishedPages) {
            const expected = 'https://niwantha33.github.io/micropython-studio/' +
                (name === 'index.html' ? '' : name);
            assert.ok(xml.includes('<loc>' + expected + '</loc>'), name);
        }
        assert.ok(content('robots.txt').includes('/micropython-studio/sitemap.xml'));
    });

    test('help pages include readable links, keyboard focus and reduced-motion styling', () => {
        const css = content('site-docs.css');
        assert.ok(css.includes(':focus-visible'));
        assert.ok(css.includes('prefers-reduced-motion'));
        assert.ok(css.includes('@media(max-width:820px)'));
        assert.ok(content('getting-started.html').includes('Setup Development Environment'));
        assert.ok(content('getting-started.html').includes('first working REPL'));
    });
});
