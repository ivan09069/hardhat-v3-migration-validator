import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./validate-hardhat-v3.mjs', import.meta.url));
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'hhv-safety-'));
  try {
    const project = join(root, 'project with spaces'); mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { hardhat: '^3.0.0' } }));
    writeFileSync(join(project, 'hardhat.config.js'), "throw new Error('CONFIG_EXECUTED');");
    const pkg = join(project, 'node_modules/hardhat'); mkdirSync(pkg, {recursive:true});
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: 'cli.cjs' }));
    const marker = join(root, 'execution-marker');
    writeFileSync(join(pkg, 'cli.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const run = (...args) => spawnSync(process.execPath, [cli, '--project', project, ...args], { cwd:root, encoding:'utf8', timeout:10000 });
    fn({root,project,marker,run});
  } finally { rmSync(root,{recursive:true,force:true}); }
}
test('default run does not execute project code or write into either directory', () => fixture(({root,project,marker,run}) => {
  const before = readdirSync(project).sort(); const rootBefore = readdirSync(root).sort();
  const result = run(); assert.ok([0,1,2].includes(result.status),result.stderr);
  assert.equal(existsSync(marker),false);
  assert.deepEqual(readdirSync(project).sort(),before); assert.deepEqual(readdirSync(root).sort(),rootBefore);
}));
test('reports go only to requested directory and cannot overwrite', () => fixture(({root,project,run}) => {
  const out = join(root,'reports');
  const args = ['--json','--markdown','--output-dir',out];
  assert.ok([0,1,2].includes(run(...args).status));
  const path = join(out,'hardhat-v3-validator-report.json'); const before = readFileSync(path);
  assert.equal(existsSync(join(project,'hardhat-v3-validator-report.json')),false);
  assert.equal(run(...args).status,3); assert.deepEqual(readFileSync(path),before);
}));
test('no-exec overrides exec, while explicit exec runs the installed CLI', () => fixture(({marker,run}) => {
  run('--exec','--no-exec'); assert.equal(existsSync(marker),false);
  run('--exec'); assert.equal(existsSync(marker),true);
}));
