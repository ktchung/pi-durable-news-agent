import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const authRoles = ['auth-login', 'auth-status', 'auth-logout'];
export function validate(role, env = process.env) {
  const errors = [];
  const nonempty = (name) => {
    if (!env[name]?.trim()) errors.push(`${name} is required`);
  };
  const token = (name) => {
    if ((env[name]?.trim().length ?? 0) < 32) errors.push(`${name} needs at least 32 characters`);
  };
  if (!['api', 'hub', 'ticker', ...authRoles].includes(role)) return ['Unknown container role'];
  // Bootstrap auth without API/cron, Jev or paid API credentials.
  if (authRoles.includes(role)) {
    nonempty('DNA_CODEX_AUTH_DIR');
    return errors;
  }
  if (role !== 'ticker') token('DNA_CLIENT_TOKEN');
  if (role !== 'hub') token('DNA_CRON_TOKEN');
  if (role === 'api') {
    const provider = env.DNA_PROVIDER || 'codex';
    if (env.DNA_CLIENT_TOKEN?.trim() === env.DNA_CRON_TOKEN?.trim()) errors.push('Client and cron tokens must differ');
    if (provider === 'faux') {
      if (env.JEV_BACKEND !== 'fixture' || env.DNA_SEARCH_MODE !== 'fixture')
        errors.push('Faux mode requires JEV_BACKEND=fixture and DNA_SEARCH_MODE=fixture');
    } else if (provider === 'openrouter' || provider === 'codex') {
      if (provider === 'openrouter') nonempty('OPENROUTER_API_KEY');
      if (provider === 'codex') {
        nonempty('DNA_CODEX_AUTH_DIR');
        if (env.JEV_BACKEND !== 'typesafe') errors.push('Codex requires JEV_BACKEND=typesafe; no OpenRouter fallback');
      }
      if (env.JEV_BACKEND === 'typesafe') nonempty('TYPESAFE_API_KEY');
      else if (provider !== 'openrouter' || env.JEV_BACKEND !== 'openrouter')
        errors.push('Select JEV_BACKEND=typesafe or openrouter explicitly');
      if (!['web', 'firecrawl'].includes(env.DNA_SEARCH_MODE)) errors.push('Select DNA_SEARCH_MODE=web or firecrawl');
    } else errors.push('Select DNA_PROVIDER=codex, openrouter or faux explicitly');
  }
  if (role === 'ticker' && env.DNA_AUTOMATION_ENABLED !== 'true')
    errors.push('Automation is disabled; set DNA_AUTOMATION_ENABLED=true only after approval');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const role = process.argv[2];
  const errors = validate(role);
  if (errors.length) {
    for (const error of errors) console.error(`Preflight: ${error}`);
    process.exit(64);
  }
  const needsAuth = authRoles.includes(role) || (role === 'api' && (!process.env.DNA_PROVIDER || process.env.DNA_PROVIDER === 'codex'));
  if (needsAuth) {
    try {
      const dir = resolve(process.env.DNA_CODEX_AUTH_DIR);
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.mode & 0o077 || realpathSync(dir) !== dir) throw new Error('private directory required');
      accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      console.error('Preflight: Codex auth directory must exist, be private (0700), writable and not symlinked');
      process.exit(73);
    }
  }
  if (!authRoles.includes(role)) {
    try {
      const dirs = [process.env.DNA_LOG_DIR ?? '/logs'];
      if (role === 'api') dirs.push(process.env.DNA_DATA_DIR ?? '/data');
      for (const dir of dirs) {
        mkdirSync(dir, { recursive: true });
        accessSync(dir, constants.W_OK);
      }
    } catch {
      console.error('Preflight: state/log directory is not writable; check host directory ownership');
      process.exit(73);
    }
  }
}
