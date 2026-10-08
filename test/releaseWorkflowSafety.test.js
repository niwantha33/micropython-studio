'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Release-tag guard and public publishing safety', () => {
    const workflow = fs.readFileSync(
        path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

    test('only an exact numeric stable vMAJOR.MINOR.PATCH name is eligible', () => {
        // Mirror the GitHub Actions Bash regex in the workflow.
        const stable = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
        assert.ok(stable.test('v2.6.0'));
        assert.ok(stable.test('v2.6.1'));
        for (const tag of ['v2.6.0_r', 'v2.6.0-rc1', 'v2.6.0-beta.1',
                           'v2.6.0+local', 'v2.6', 'v02.6.0']) {
            assert.ok(!stable.test(tag), 'Non-release tag was eligible: ' + tag);
        }
        assert.ok(workflow.includes('^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'));
        assert.ok(workflow.includes('release_eligible=false'));
        assert.ok(workflow.includes('release_eligible=true'));
    });

    test('neither GitHub Release nor marketplaces can run without eligible approval', () => {
        const guard = "if: startsWith(github.ref, 'refs/tags/v') && needs.verify-release.outputs.release_eligible == 'true'";
        assert.strictEqual(workflow.split(guard).length - 1, 2);
        assert.ok(workflow.includes('needs: [build-vsix, verify-release]'));
        assert.ok(workflow.includes('git merge-base --is-ancestor HEAD origin/main'));
        assert.ok(workflow.includes('if [ "$tag_version" != "$package_version" ]; then'));
        assert.ok(workflow.includes('exit 1'));
    });

    test('non-release suffix tags are treated as test builds, without publishing or rewriting versions', () => {
        assert.ok(workflow.includes('Suffix tags such as v2.6.0_r are development/test markers'));
        assert.ok(workflow.includes('Build/tests may run, but GitHub Release and both registries are skipped.'));
        assert.ok(!workflow.includes("npm version"));
        assert.ok(!workflow.includes('git tag -f'));
    });
});
