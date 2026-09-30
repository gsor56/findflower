// Run once inside the deployed server directory, after a completed deployment.
// Authentication uses the server's configured Git credential helper/deploy key.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const state = path.join(root, '.hidencloud');
const checkout = path.join(state, 'repo');
const repository = 'https://github.com/gsor56/findflower.git';
const options = { cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] };

function main() {
    const version = execFileSync('git', ['--version'], options).trim();
    if (!fs.existsSync(path.join(state, 'deployment.json'))) {
        throw new Error('Complete the initial full deployment before setting up reverse sync');
    }
    if (!fs.existsSync(checkout)) {
        execFileSync('git', ['clone', '--branch', 'main', '--single-branch', repository, checkout], options);
    } else if (!fs.existsSync(path.join(checkout, '.git'))) {
        throw new Error('The sync checkout path exists but is not a Git repository; inspect it first');
    }
    const gitOptions = { ...options, cwd: checkout };
    if (execFileSync('git', ['status', '--porcelain'], gitOptions).trim()) {
        throw new Error('The sync checkout has pending changes; setup will not overwrite them');
    }
    execFileSync('git', ['fetch', 'origin', 'main'], gitOptions);
    // Verifies write credentials without modifying the remote repository.
    execFileSync('git', ['push', '--dry-run', 'origin', 'HEAD:main'], gitOptions);
    console.log(version + '; sync checkout and GitHub write access verified.');
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    const command = `cd ${quote(root)} && ${quote(process.execPath)} scripts/sync-server-to-github.mjs >> ${quote(path.join(state, 'sync.log'))} 2>&1`;
    if (process.argv.includes('--install-cron')) {
        if (process.platform === 'win32') throw new Error('Cron setup is for the Linux HidenCloud server');
        let current = '';
        try { current = execFileSync('crontab', ['-l'], options); }
        catch (error) {
            if (error.code === 'ENOENT') throw new Error('crontab is not installed; use npm run sync:server:watch in the server process manager');
            if (!/no crontab/i.test(String(error.stderr))) throw error;
        }
        const marker = '# findflower-reverse-sync';
        const lines = current.split('\n').filter(line => !line.includes(marker));
        // Cron treats percent signs specially even inside shell quotes.
        lines.push(`*/5 * * * * ${command.replace(/%/g, '\\%')} ${marker}`);
        execFileSync('crontab', ['-'], { ...options, stdio: ['pipe', 'pipe', 'pipe'], input: lines.filter(Boolean).join('\n') + '\n' });
        console.log('Installed reverse sync every five minutes in this user\'s crontab.');
    } else {
        console.log('Start periodic sync with npm run sync:server:watch, or rerun setup with --install-cron.');
    }
}

try { main(); }
catch (error) {
    console.error(error.status === undefined ? error.message : `Setup command failed (exit ${error.status}); inspect server Git/cron configuration`);
    process.exitCode = 1;
}
