const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Discoverability without unsupported debugger claims', () => {
  const repo = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8'));
  const readme = fs.readFileSync(path.join(repo,'README.md'),'utf8');
  const landing = fs.readFileSync(path.join(repo,'micropython-live-debugger.html'),'utf8');
  const sitemap = fs.readFileSync(path.join(repo,'sitemap.xml'),'utf8');

  test('Marketplace metadata focuses on the tested live debugger', () => {
    assert.strictEqual(pkg.publisher, 'niwantha33');
    assert.strictEqual(pkg.name, 'micropython-studio');
    assert.ok(pkg.categories.includes('Debuggers'));
    assert.ok(pkg.keywords.includes('micropython debugger'));
    assert.ok(pkg.description.includes('Pico 2 W'));
    assert.ok(!pkg.description.toLowerCase().includes('first ever'));
  });
  test('README includes real video and separate experimental firmware caveat', () => {
    assert.ok(readme.includes('https://www.youtube.com/watch?v=or_aG-Rhnb8'));
    assert.ok(readme.includes('hardware qualification'));
    assert.ok(readme.includes('ESP32-C3 debugger has **not** been released'));
  });
  test('automatic public release requires tag from main with matching version', () => {
    const workflow = fs.readFileSync(path.join(repo,'.github','workflows','ci.yml'),'utf8');
    assert.ok(workflow.includes("name: Verify approved release tag"));
    assert.ok(workflow.includes('git merge-base --is-ancestor HEAD origin/main'));
    assert.ok(workflow.includes('tag_version="${GITHUB_REF_NAME#v}"'));
    assert.ok(workflow.includes('needs: [build-vsix, verify-release]'));
  });
  test('public landing page is canonical, indexable and installation-linked', () => {
    assert.ok(landing.includes('micropython-live-debugger.html'));
    assert.ok(landing.includes('rel="canonical"'));
    assert.ok(landing.includes('application/ld+json'));
    assert.ok(landing.includes('itemName=niwantha33.micropython-studio'));
    assert.ok(landing.includes('full stability checks are pending'));
    assert.ok(sitemap.includes('micropython-live-debugger.html'));
  });
});
