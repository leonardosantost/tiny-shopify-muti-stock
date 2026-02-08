import { getConfigValue, addLog } from '../lib/db.js';
import { env } from '../lib/env.js';
import { runFullSync } from './sync.js';

let timer = null;

function currentIntervalMinutes() {
  const configured = Number(getConfigValue('sync_interval_minutes', String(env.syncIntervalMinutes)));
  if (!Number.isFinite(configured) || configured <= 0) return env.syncIntervalMinutes;
  return configured;
}

export function startScheduler() {
  restartScheduler();
}

export function restartScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  const intervalMinutes = currentIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  timer = setInterval(() => {
    runFullSync({ trigger: 'scheduler' }).catch((error) => {
      addLog({
        type: 'scheduler',
        status: 'error',
        message: error.message,
        context: null
      });
    });
  }, intervalMs);

  addLog({
    type: 'scheduler',
    status: 'ok',
    message: `Scheduler ativo: ${intervalMinutes} minuto(s)`,
    context: { intervalMinutes }
  });
}

export function getSchedulerStatus() {
  return {
    running: Boolean(timer),
    intervalMinutes: currentIntervalMinutes()
  };
}
