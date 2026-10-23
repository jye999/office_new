// ExecController (routes/web.php:47-48 role:admin, 108-109 role:admin,user,remote).
// /exec.run and /exec.refreshAmz execute artisan commands — in the old app this
// is a deliberate admin backdoor (the command name is typed into a form field).
// Commands are ported in Phase 5 and registered via registerArtisanCommand();
// unknown commands 500 with Laravel's "Command \"x\" is not defined."

import type { FastifyInstance } from 'fastify';
import { allInput, input, lredirect } from '../../http.js';
import { artisanCall } from '../../jobs/artisan.js';
import { route } from '../../router.js';
import { render } from '../../view.js';

function sessionCode(req: Parameters<typeof render>[0]): string {
  const v = (req.session as Record<string, unknown>)['code'];
  return v === null || v === undefined ? '' : String(v);
}

export function registerExecRoutes(app: FastifyInstance): void {
  // Route::get('/exec') -> index: show the flashed exit code from the last run.
  route(app, {
    verb: 'get',
    path: '/exec',
    name: 'exec',
    middleware: ['web', 'role:admin'],
    handler: async (req, reply) => {
      await render(req, reply, 'exec/index', { code: sessionCode(req) });
    },
  });

  // Route::post('/exec.run') -> runit. PHP quirk: $command is only assigned when
  // BOTH what and who are present; otherwise Artisan::call(null) throws
  // "Command "" is not defined." (500), after the Log line with the empties.
  route(app, {
    verb: 'post',
    path: '/exec.run',
    name: 'exec.run',
    middleware: ['web', 'role:admin'],
    handler: async (req, reply) => {
      const what = input(req, 'what');
      const who = input(req, 'who');
      let command: unknown;
      if (what !== null && who !== null) command = what;
      console.log(`executing ${command ?? ''} ${who ?? ''}`);
      const exitCode = await artisanCall(command, { action: String(who ?? '') });
      (req.session as { set?: (k: string, v: unknown) => void }).set?.('flash', {
        ...((req.session as Record<string, unknown>)['flash'] as object ?? {}),
        code: exitCode,
      });
      reply.withInput(allInput(req));
      return lredirect(req, reply, '/exec');
    },
  });

  // Route::post('/exec.refreshAmz') -> refreshAmz: sync get-amz-image-by-asin.
  route(app, {
    verb: 'post',
    path: '/exec.refreshAmz',
    name: 'exec.refreshAmz',
    middleware: ['web', 'role:admin,user,remote'],
    handler: async (req, reply) => {
      const asin = input(req, 'asin');
      if (asin === null) return lredirect(req, reply, '/refreshAmzImg');
      console.log(`executing sync get-amz-image-by-asin ${asin}`);
      const exitCode = await artisanCall('sync', { action: 'get-amz-image-by-asin', arg1: String(asin) });
      (req.session as { set?: (k: string, v: unknown) => void }).set?.('flash', {
        ...((req.session as Record<string, unknown>)['flash'] as object ?? {}),
        code: exitCode,
      });
      reply.withInput(allInput(req));
      return lredirect(req, reply, '/refreshAmzImg');
    },
  });

  // Route::get('/refreshAmzImg') -> getRefreshAmz.
  route(app, {
    verb: 'get',
    path: '/refreshAmzImg',
    name: 'refreshAmzImg',
    middleware: ['web', 'role:admin,user,remote'],
    handler: async (req, reply) => {
      await render(req, reply, 'exec/amazon-refresh', { code: sessionCode(req) });
    },
  });
}
