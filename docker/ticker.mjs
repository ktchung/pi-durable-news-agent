// Reuse upstream's idempotent tick and retry logic without modifying host crontab.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const untilNextMinute = (now = Date.now()) => 60000 - (now % 60000);

export async function runTicker() {
  const controller = new AbortController();
  let child;
  const stop = () => {
    controller.abort();
    child?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log('Ticker enabled; first tick is at the next minute boundary');
  try {
    while (!controller.signal.aborted) {
      await delay(untilNextMinute(), undefined, { signal: controller.signal });
      if (controller.signal.aborted) break;
      const code = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, ['--import', 'tsx', 'apps/dna-server-cron/src/main.ts', 'tick'], {
          cwd: process.env.DNA_APP_ROOT ?? '/app', stdio: 'inherit', env: process.env,
        });
        child.once('error', reject);
        child.once('exit', (code) => { child = undefined; resolve(code); });
      });
      if (code !== 0 && !controller.signal.aborted)
        console.error('Tick failed; upstream retries finished. Next minute slot will be attempted.');
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Defense in depth if someone bypasses the normal entrypoint.
  if (process.env.DNA_AUTOMATION_ENABLED !== 'true') {
    console.error('Automation is disabled');
    process.exit(64);
  }
  await runTicker();
}
