// Runs with local Git repositories only; no GitHub or production credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildManifest } from './manifest.mjs';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sync-test-'));
const origin = path.join(temporary, 'origin.git');
const seed = path.join(temporary, 'seed');
const live = path.join(temporary, 'live');
const clone = path.join(live, '.hidencloud/repo');
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const write = (base, file, content) => { fs.mkdirSync(path.dirname(path.join(base,file)), {recursive:true}); fs.writeFileSync(path.join(base,file), content); };
const sync = () => execFileSync(process.execPath, [path.join(live, 'scripts/sync-server-to-github.mjs')], { cwd: live, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
try {
    git(temporary, 'init', '--bare', origin);
    git(temporary, 'init', '-b', 'main', seed);
    // Production runs on Linux. Keep these disposable fixture checkouts on LF
    // even when the Windows user's global Git config enables core.autocrlf.
    git(seed, 'config', 'core.autocrlf', 'false');
    git(seed, 'config', 'core.eol', 'lf');
    write(seed, 'how.html', 'original\n');
    write(seed, 'about.html', 'about\n');
    for (const file of ['scripts/sync-server-to-github.mjs', 'scripts/hidencloud/manifest.mjs']) {
        write(seed, file, fs.readFileSync(new URL('../../' + file, import.meta.url)));
    }
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-u', 'origin', 'main');
    fs.mkdirSync(live, {recursive:true});
    fs.cpSync(seed, live, {recursive:true, filter: name => path.basename(name) !== '.git'});
    fs.mkdirSync(path.dirname(clone), {recursive:true});
    git(temporary, 'clone', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '--branch', 'main', origin, clone);
    write(live, '.hidencloud/deployment.json', JSON.stringify(buildManifest(seed)));
    write(live, '.env', 'NEVER_COMMIT=this-secret\n');

    assert.match(sync(), /No deployed file changes/);
    write(live, 'how.html', 'server edit one\n');
    sync();
    git(seed, 'pull', '--ff-only');
    assert.equal(fs.readFileSync(path.join(seed,'how.html'),'utf8'), 'server edit one\n');
    assert.equal(git(seed, 'ls-files', '.env'), '');
    assert.match(sync(), /No deployed file changes/);

    // Another edit before CI deploys must use the previous server snapshot.
    write(live, 'how.html', 'server edit two\n');
    write(live, 'scripts/new-widget.js', 'export const ready = true;\n');
    sync(); git(seed, 'pull', '--ff-only');
    assert.equal(fs.readFileSync(path.join(seed,'how.html'),'utf8'), 'server edit two\n');
    assert.ok(fs.existsSync(path.join(seed,'scripts/new-widget.js')));

    fs.unlinkSync(path.join(live, 'scripts/new-widget.js'));
    sync(); git(seed, 'pull', '--ff-only');
    assert.equal(git(seed, 'ls-files', 'scripts/new-widget.js'), '');
    assert.match(sync(), /No deployed file changes/);

    // Independent GitHub edits merge; conflicting edits are retained locally.
    write(seed, 'about.html', 'github edit\n'); git(seed,'add','.'); git(seed,'commit','-m','GitHub edit'); git(seed,'push');
    write(live, 'how.html', 'server edit three\n'); sync(); git(seed,'pull','--ff-only');
    assert.equal(fs.readFileSync(path.join(seed,'about.html'),'utf8'), 'github edit\n');
    write(seed, 'how.html', 'conflicting github edit\n'); git(seed,'add','.'); git(seed,'commit','-m','conflict'); git(seed,'push');
    const before = git(seed,'rev-parse','HEAD');
    write(live, 'how.html', 'conflicting server edit\n');
    assert.throws(sync);
    git(seed, 'fetch'); assert.equal(git(seed, 'rev-parse', 'origin/main'), before);
    assert.equal(fs.readFileSync(path.join(live,'how.html'),'utf8'), 'conflicting server edit\n');
    assert.ok(git(clone, 'branch', '--list', 'server-sync/*'));
    console.log('PASS: reverse sync, additions, deletions, repeated edits, independent merges and conflict preservation');
} finally {
    // This is the exact directory returned by mkdtemp, never a user path.
    fs.rmSync(temporary, { recursive: true, force: true });
}
