import type { RequestHandler } from 'express';
import type { ModuleService, ModuleState } from './service.js';
import { HttpError } from '../util/errors.js';
import { moduleOffMessage } from './service.js';
import { moduleDecl } from './registry.js';

/**
 * The route guard for a module that can be switched off: a small wrapper beside requirePermission,
 * not a new framework. A route in a module that is off answers 409 module_off naming the module,
 * never 404, so the reason is legible to whoever pressed it.
 *
 * The state is read once per request whatever the number of guards on it, so a router that guards
 * twice costs one read, not two.
 */
const MEMO = Symbol('moduleState');

export function requireModule(modules: ModuleService, key: string): RequestHandler {
  return async (req, _res, next) => {
    try {
      const holder = req as unknown as { [MEMO]?: Promise<ModuleState> };
      holder[MEMO] ??= modules.state();
      const state = await holder[MEMO];
      const view = state.modules.find((m) => m.key === key);
      if (view && !view.on) {
        const name = moduleDecl(key)?.name ?? key;
        throw new HttpError(409, 'module_off', moduleOffMessage(name), { module: key });
      }
      next();
    } catch (e) { next(e); }
  };
}
