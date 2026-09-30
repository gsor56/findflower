// Run from cron every five minutes, or keep `--watch` running in the panel.
// Git credentials belong in the server credential helper, never in this file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, assertSafeEntry, sourceForLive } from './hidencloud/manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.join(root, '.hidencloud');
const repo = path.join(state, 'repo');
const lock = path.join(state, 'lock');
const manifestPath = path.join(state, 'deployment.json');
const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function sync() {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    if (!fs.existsSync(manifestPath)) throw new Error('No completed deployment manifest; finish the initial deployment first');
    try { fs.mkdirSync(lock); } catch (error) {
        if (error.code === 'EEXIST') { console.log('Deploy/sync lock exists; skipping'); return; }
        throw error;
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.files.forEach(assertSafeEntry);
        if (!fs.existsSync(path.join(repo, '.git'))) {
            throw new Error('Create .hidencloud/repo from the GitHub repository and configure a write credential first');
        }
        git('fetch', 'origin', 'main');
        if (git('status', '--porcelain')) throw new Error('Sync checkout has pending edits; inspect it before resuming');
        if (git('branch', '--show-current') !== 'main') throw new Error('Sync checkout must be on main');
        try { git('merge-base', '--is-ancestor', 'HEAD', 'origin/main'); } catch {
            throw new Error('An unpushed sync commit exists; inspect .hidencloud/repo');
        }
        // Discover new code/assets only inside the same deployment allowlist.
        // Runtime state, credentials, node_modules and hidden paths never enter Git.
        const known = new Set(manifest.files.map(entry => entry.destination));
        function discover(dir, prefix = '') {
            for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                const dest = prefix + item.name;
                if (item.isSymbolicLink()) continue;
                if (item.isDirectory()) {
                    if (!prefix && !['routes','lib','views','models','assets','articles','scripts','chat','notifications'].includes(item.name)) continue;
                    if (item.name.startsWith('.') || ['node_modules','generate-showcase','scratch'].includes(item.name)) continue;
                    discover(path.join(dir, item.name), dest + '/');
                } else {
                    const source = sourceForLive(dest);
                    if (!known.has(dest) && source) {
                        known.add(dest);
                        manifest.files.push({ source, destination: dest, sha256: null });
                    }
                }
            }
        }
        discover(root);
        // Reconstruct edits against the deployed commit, not against a newer
        // GitHub version that might have changed the same lines.
        git('checkout', '--detach', manifest.baselineRevision || manifest.revision);
        const changed = [];
        for (const entry of manifest.files) {
            const live = path.join(root, entry.destination);
            const target = path.join(repo, entry.source);
            if (fs.existsSync(live) && fs.lstatSync(live).isSymbolicLink()) throw new Error(`Refusing symlink: ${entry.destination}`);
            const bytes = fs.existsSync(live) ? fs.readFileSync(live) : null;
            if ((bytes ? sha256(bytes) : null) === entry.sha256) continue;
            changed.push({ entry, bytes });
            if (bytes) {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, bytes);
            } else if (fs.existsSync(target)) fs.unlinkSync(target);
            git('add', '-A', '--', entry.source);
        }
        if (!changed.length) {
            git('checkout', 'main');
            console.log('No deployed file changes');
            return;
        }
        git('-c', 'user.name=HidenCloud Sync', '-c', 'user.email=gsor56@users.noreply.github.com',
            'commit', '-m', 'sync(server): automated sync from HidenCloud');
        const snapshot = git('rev-parse', 'HEAD');
        // Retain a named recovery branch even if cherry-pick or push fails.
        git('branch', `server-sync/${snapshot.slice(0,12)}`, snapshot);
        git('checkout', 'main');
        git('merge', '--ff-only', 'origin/main');
        try { git('-c', 'user.name=HidenCloud Sync', '-c', 'user.email=gsor56@users.noreply.github.com', 'cherry-pick', snapshot); } catch {
            git('cherry-pick', '--abort');
            throw new Error(`Conflicting changes. Snapshot preserved at server-sync/${snapshot.slice(0,12)}; live files untouched`);
        }
        // A racing GitHub push is rejected normally. Never force-push.
        git('push', 'origin', 'HEAD:main');
        // Keep the original deployed revision: a merged GitHub commit can
        // include changes not yet live. Record the pushed snapshot separately.
        manifest.serverSyncRevision = git('rev-parse', 'HEAD');
        manifest.baselineRevision = snapshot;
        for (const { entry, bytes } of changed) entry.sha256 = bytes ? sha256(bytes) : null;
        // The deployer needs the actual live baseline, including deletions.
        fs.writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2));
        fs.renameSync(manifestPath + '.tmp', manifestPath);
        console.log(`Pushed ${changed.length} server edits; the GitHub workflow will deploy the merged tree`);
    } finally {
        fs.rmdirSync(lock);
    }
}

function run() {
    try { sync(); } catch (error) {
        // Git may include a remote URL in stderr. Report our context without
        // echoing credential-bearing command output.
        console.error(error.status === undefined ? error.message : `Git command failed (exit ${error.status}); inspect the sync checkout`);
        process.exitCode = 1;
    }
}
run();
if (process.argv.includes('--watch')) setInterval(run, 5 * 60 * 1000);
