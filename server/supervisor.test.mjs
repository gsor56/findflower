// Exercises the supervisor with real child processes: the fake app records one
// line per start, so a restart is a second line and "kept the old process" is
// still one. Only npm and the install step are faked, because installing the
// real dependencies in a temp directory would prove nothing about the logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from './supervisor.js';

const ALIVE = "const fs = require('node:fs');\n"
    + "fs.appendFileSync('starts.log', process.pid + '\\n');\n"
    + 'setInterval(() => {}, 1000);\n';

const CRASHING = "const fs = require('node:fs');\n"
    + "fs.appendFileSync('starts.log', process.pid + '\\n');\n"
    + 'setTimeout(() => process.exit(1), 150);\n';

function makeRoot(app = ALIVE) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ff-supervisor-'));
    writeFileSync(path.join(root, 'app.js'), app);
    writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    return root;
}

const starts = root => {
    try { return readFileSync(path.join(root, 'starts.log'), 'utf8').trim().split('\n').filter(Boolean); }
    catch { return []; }
};

const stamp = (root, commit) => {
    mkdirSync(path.join(root, '.deploy'), { recursive: true });
    writeFileSync(path.join(root, '.deploy', 'stamp'), JSON.stringify({ commit, builtAt: new Date().toISOString() }));
};

async function until(check, timeout = 8000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (check()) return;
        if (Date.now() > deadline) throw new Error('timed out waiting for the supervisor');
        await new Promise(resolve => setTimeout(resolve, 40));
    }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function build(root, overrides = {}) {
    const lines = [];
    const supervisor = createSupervisor({
        root,
        entry: 'app.js',
        pollMs: 60,
        graceMs: 2000,
        healthyMs: 500,
        bootRetryMs: 100,
        backoffMs: [50],
        install: async () => true,
        log: line => lines.push(line),
        ...overrides,
    });
    return { supervisor, lines };
}

async function withSupervisor(app, run, overrides) {
    const root = makeRoot(app);
    const { supervisor, lines } = build(root, overrides);
    try {
        await run({ root, supervisor, lines });
    } finally {
        await supervisor.stop();
        rmSync(root, { recursive: true, force: true });
    }
}

test('a changed deploy stamp restarts the app and names the commit', async () => {
    await withSupervisor(ALIVE, async ({ root, supervisor, lines }) => {
        await supervisor.start();
        await until(() => starts(root).length === 1);
        const commit = 'a'.repeat(40);
        stamp(root, commit);
        await until(() => starts(root).length === 2);
        const pids = starts(root);
        assert.notEqual(pids[0], pids[1], 'the second start must be a new process');
        assert.ok(lines.some(line => line.includes(`stamp changed to ${commit}`)));
        assert.ok(lines.some(line => line.includes(`starting app.js at ${commit}`)));
    });
});

test('a failed dependency install keeps the running app', async () => {
    let failing = false;
    await withSupervisor(ALIVE, async ({ root, supervisor, lines }) => {
        await supervisor.start();
        await until(() => starts(root).length === 1);
        failing = true;
        writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
        stamp(root, 'b'.repeat(40));
        await until(() => lines.some(line => line.includes('keeping the running app')));
        await pause(300);
        assert.equal(starts(root).length, 1, 'the old process must survive a failed install');
        assert.ok(lines.some(line => line.includes('npm ci failed')));
    }, { install: async () => !failing });
});

test('a lock file newer than node_modules is installed instead of adopted', async () => {
    let installs = 0;
    await withSupervisor(ALIVE, async ({ root, supervisor, lines }) => {
        const modules = path.join(root, 'node_modules');
        mkdirSync(modules, { recursive: true });
        const older = new Date(Date.now() - 60000);
        utimesSync(modules, older, older);
        await supervisor.start();
        await until(() => starts(root).length === 1);
        assert.equal(installs, 1, 'a deploy uploads the lock after the modules were built, so it has to install');
        assert.ok(!lines.some(line => line.includes('adopted')));
    }, { install: async () => { installs += 1; return true; } });
});

test('node_modules newer than the lock file is adopted without installing', async () => {
    let installs = 0;
    await withSupervisor(ALIVE, async ({ root, supervisor, lines }) => {
        const lock = path.join(root, 'package-lock.json');
        const older = new Date(Date.now() - 60000);
        utimesSync(lock, older, older);
        mkdirSync(path.join(root, 'node_modules'), { recursive: true });
        await supervisor.start();
        await until(() => starts(root).length === 1);
        assert.equal(installs, 0, 'modules built from this lock file are what the panel installed');
        assert.ok(lines.some(line => line.includes('adopted the existing node_modules')));
    }, { install: async () => { installs += 1; return true; } });
});

test('an app that exits is started again', async () => {
    await withSupervisor(CRASHING, async ({ root, supervisor, lines }) => {
        await supervisor.start();
        await until(() => starts(root).length >= 2, 6000);
        assert.ok(lines.some(line => line.includes('exited (code 1')));
        assert.ok(lines.some(line => line.includes('crash 1')));
    });
});

test('a stamp that is already on disk at boot does not restart the app', async () => {
    await withSupervisor(ALIVE, async ({ root, supervisor }) => {
        stamp(root, 'c'.repeat(40));
        await supervisor.start();
        await until(() => starts(root).length === 1);
        await pause(400);
        assert.equal(starts(root).length, 1, 'a supervisor restarted after a deploy must not restart the app again');
    });
});

test('stopping the supervisor stops the app and does not bring it back', async () => {
    await withSupervisor(ALIVE, async ({ root, supervisor }) => {
        await supervisor.start();
        await until(() => starts(root).length === 1);
        await supervisor.stop();
        assert.equal(supervisor.status().running, false);
        await pause(300);
        assert.equal(starts(root).length, 1);
    });
});
