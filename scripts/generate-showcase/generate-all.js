const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { optimize } = require('./optimize');
const { publish } = require('./publish');
const root = path.resolve(__dirname, '../..');

async function main() {
  const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test',
    '--config', 'scripts/generate-showcase/playwright.config.ts'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Capture failed. Existing how.html and shipped assets were not replaced.');
  await optimize();
  await publish();
  const verify = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test',
    '--config', 'scripts/generate-showcase/verify.config.ts'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (verify.error) throw verify.error;
  if (verify.status !== 0) throw new Error('Videos generated, but playback verification failed. Review before deploying.');
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
