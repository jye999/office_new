// Login validation shared by the web auth routes (routes.ts) and the guest:api routes (apiRoutes.ts).
// Self-service registration and password reset were removed on purpose: accounts and passwords are managed
// by admins only (see modules/users).

import { trans } from '../../view.js';

export type Errors = Record<string, string[]>;

export function attr(name: string): string {
  return name.replace(/_/g, ' ');
}

// Laravel `required`: null, empty/whitespace-only string.
export function required(v: unknown): boolean {
  return v !== null && v !== undefined && (typeof v !== 'string' || v.trim().length > 0);
}

function add(errors: Errors, field: string, key: string, repl: Record<string, unknown> = {}): void {
  (errors[field] ??= []).push(trans(key, { attribute: attr(field), ...repl }));
}

export function loginValidation(email: unknown, password: unknown): Errors {
  const errors: Errors = {};
  for (const [field, v] of [['email', email], ['password', password]] as const) {
    if (!required(v)) add(errors, field, 'validation.required');
    else if (typeof v !== 'string') add(errors, field, 'validation.string');
  }
  return errors;
}
