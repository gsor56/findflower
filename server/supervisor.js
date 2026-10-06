// The panel's startup command. It owns the app process, so that a deploy can
// take effect without the panel API: the deploy writes .deploy/stamp as its
// very last upload, this process notices the stamp change, installs
// dependencies if package-lock.json moved, and restarts the app.
//
// Nothing here calls HidenCloud. Their client API keys are short-lived, so a
// restart issued from CI cannot be relied on, and the only thing the panel has
// to do is run this file and, when asked, signal it.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const defaults = {
    root: HERE,
    entry: 'index.js',
    stamp: '.deploy/stamp',
    state: '.deploy/deps.json',
    lock: 'package-lock.json',
    modules: 'node_modules',
    pollMs: 3000,
    // server.close() waits for open connections, and the event stream holds one
    // open for as long as a browser keeps it. The app gets this long to leave on
    // its own before it is killed outright.
    graceMs: 20000,
    // An app that stayed up this long was working; its exit starts a fresh
    // backoff instead of continuing the previous one.
    healthyMs: 60000,
    bootRetryMs: 30000,
    backoffMs: [1000, 2000, 5000, 10000, 30000],
};

const digestOf = file => existsSync(file)
    ? createHash('sha256').update(readFileSync(file)).digest('hex')
    : null;

function commitOf(stamp) {
    try {
        const parsed = JSON.parse(stamp);
        if (typeof parsed.commit === 'string' && parsed.commit) return parsed.commit;
    } catch {}
    return stamp.trim() || 'unknown';
}

function npmInstall(root) {
    return new Promise(resolve => {
        const child = spawn('npm', ['ci', '--omit=dev'], {
            cwd: root,
            stdio: 'inherit',
            // npm is a shell script on Windows and a .cmd shim cannot be spawned
            // directly since Node 18; the command is fixed, so a shell is safe.
            shell: process.platform === 'win32',
        });
        child.on('error', error => {
            console.error(`[supervisor] npm could not start: ${error.message}`);
            resolve(false);
        });
        child.on('exit', code => resolve(code === 0));
    });
}

export function createSupervisor(options = {}) {
    const config = { ...defaults, ...options };
    const log = config.log || ((...args) => console.log('[supervisor]', ...args));
    const install = config.install || npmInstall;
    const spawnApp = config.spawn || ((entry, options) => spawn(process.execPath, [entry], options));

    const at = name => path.join(config.root, name);

    let app = null;
    let appStartedAt = 0;
    let stamp = null;
    let crashes = 0;
    let stopping = false;
    let replacing = false;
    let pollTimer = null;
    let crashTimer = null;
    let bootTimer = null;
    let polling = false;

    const readStamp = () => {
        try { return readFileSync(at(config.stamp), 'utf8'); }
        catch { return null; }
    };

    function installedLock() {
        try { return JSON.parse(readFileSync(at(config.state), 'utf8')).lockSha256 || null; }
        catch { return null; }
    }

    function recordLock(sha) {
        mkdirSync(path.dirname(at(config.state)), { recursive: true });
        writeFileSync(at(config.state), JSON.stringify({
            lockSha256: sha,
            installedAt: new Date().toISOString(),
        }, null, 2));
    }

    // True when the app can be started: either the dependencies already match the
    // lock file, or npm put them there. A failed install leaves the previous
    // process running, because starting a new one on half-installed modules turns
    // a failed deploy into an outage.
    async function ensureDependencies(reason) {
        const wanted = digestOf(at(config.lock));
        if (!wanted) return true;
        if (wanted === installedLock()) return true;
        if (!existsSync(at(config.modules)) && !installedLock()) {
            log(`${reason}: no node_modules; installing`);
        } else {
            log(`${reason}: installing dependencies for the new lock file`);
        }
        if (!await install(config.root)) {
            log(`${reason}: npm ci failed; dependencies are unchanged`);
            return false;
        }
        recordLock(wanted);
        log(`${reason}: dependencies installed`);
        return true;
    }

    function startApp(reason) {
        const current = readStamp();
        log(`starting ${config.entry}${current ? ` at ${commitOf(current)}` : ''} (${reason})`);
        const child = spawnApp(at(config.entry), {
            cwd: config.root,
            stdio: 'inherit',
            env: process.env,
        });
        app = child;
        appStartedAt = Date.now();
        child.on('exit', (code, signal) => {
            // A child this process already replaced or killed on purpose is not a
            // crash, however late its exit event arrives.
            if (app !== child) return;
            app = null;
            if (stopping || replacing) return;
            const ranFor = Date.now() - appStartedAt;
            crashes = ranFor >= config.healthyMs ? 1 : crashes + 1;
            const wait = config.backoffMs[Math.min(crashes - 1, config.backoffMs.length - 1)];
            log(`${config.entry} exited (code ${code}, signal ${signal}) after ${Math.round(ranFor / 1000)}s; `
                + `restarting in ${wait}ms (crash ${crashes})`);
            crashTimer = setTimeout(() => { crashTimer = null; if (!stopping) startApp('crash'); }, wait);
        });
    }

    function stopApp(reason) {
        return new Promise(resolve => {
            const current = app;
            if (!current) { resolve(); return; }
            log(`${reason}: stopping the app`);
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);
                if (app === current) app = null;
                resolve();
            };
            const killTimer = setTimeout(() => {
                log(`${reason}: no clean exit after ${config.graceMs}ms; killing it`);
                try { current.kill('SIGKILL'); } catch {}
                finish();
            }, config.graceMs);
            current.once('exit', finish);
            try { current.kill('SIGTERM'); } catch { finish(); }
        });
    }

    async function restartApp(reason) {
        replacing = true;
        try {
            await stopApp(reason);
        } finally {
            replacing = false;
        }
        crashes = 0;
        startApp(reason);
    }

    async function poll() {
        if (stopping || polling) return;
        polling = true;
        try {
            const current = readStamp();
            if (current === null || current === stamp) return;
            stamp = current;
            const reason = `deploy ${commitOf(current)}`;
            log(`stamp changed to ${commitOf(current)}`);
            if (!await ensureDependencies(reason)) {
                log('keeping the running app: the new dependencies are not installed');
                return;
            }
            await restartApp(reason);
        } finally {
            polling = false;
        }
    }

    function schedule() {
        pollTimer = setTimeout(async () => {
            try { await poll(); } catch (error) { log(`poll failed: ${error.message}`); }
            if (!stopping) schedule();
        }, config.pollMs);
    }

    async function boot() {
        // node_modules installed by the panel's previous startup command matches
        // the lock file on disk, so adopt it rather than spending a cold minute on
        // npm ci before the app has even started. Any later lock change still
        // installs, because the stamp cannot change without a new deploy.
        const wanted = digestOf(at(config.lock));
        if (wanted && !installedLock() && existsSync(at(config.modules))) {
            recordLock(wanted);
            log('adopted the existing node_modules for the current lock file');
        }
        const ok = await ensureDependencies('boot');
        if (stopping) return;
        if (!ok) {
            log(`dependencies are not installed; retrying in ${config.bootRetryMs}ms`);
            bootTimer = setTimeout(() => { bootTimer = null; boot().catch(error => log(`boot failed: ${error.message}`)); }, config.bootRetryMs);
            return;
        }
        stamp = readStamp();
        startApp('boot');
    }

    return {
        start: async () => { await boot(); schedule(); },
        stop: async () => {
            stopping = true;
            clearTimeout(pollTimer);
            clearTimeout(crashTimer);
            clearTimeout(bootTimer);
            pollTimer = crashTimer = bootTimer = null;
            await stopApp('shutdown');
        },
        poll,
        status: () => ({ running: !!app, pid: app ? app.pid : null, stamp, crashes, stopping }),
    };
}

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
    const supervisor = createSupervisor();
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            console.log(`[supervisor] ${signal} -- shutting down`);
            supervisor.stop().then(() => process.exit(0), () => process.exit(1));
        });
    }
    supervisor.start().catch(error => {
        console.error(`[supervisor] could not start: ${error.message}`);
        process.exit(1);
    });
}
