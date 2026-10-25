// Validation rules + password-reset broker shared by the web auth routes
// (routes.ts) and the guest:api routes (apiRoutes.ts).

import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { db, nowDb } from '../../db.js';
import { hashPassword, verifyPassword } from '../../auth.js';
import { trans } from '../../view.js';

export type Errors = Record<string, string[]>;

export function attr(name: string): string {
  return name.replace(/_/g, ' ');
}

// filter_var(..., FILTER_VALIDATE_EMAIL) parity for the `email` rule.
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Laravel `required`: null, empty/whitespace-only string.
export function required(v: unknown): boolean {
  return v !== null && v !== undefined && (typeof v !== 'string' || v.trim().length > 0);
}

function add(errors: Errors, field: string, key: string, repl: Record<string, unknown> = {}): void {
  (errors[field] ??= []).push(trans(key, { attribute: attr(field), ...repl }));
}

// Validator runs every rule of a field (no `bail`), skipping non-implicit rules when `required` failed.
function checkEmail(errors: Errors, v: unknown): void {
  if (typeof v !== 'string' || !EMAIL_RE.test(v)) add(errors, 'email', 'validation.email');
}

function checkPasswordMin(errors: Errors, v: unknown): void {
  if (typeof v !== 'string' || v.length < 6) add(errors, 'password', 'validation.min.string', { min: 6 });
}

function checkConfirmed(errors: Errors, data: Record<string, unknown>): void {
  if (data['password'] !== data['password_confirmation']) add(errors, 'password', 'validation.confirmed');
}

export function loginValidation(email: unknown, password: unknown): Errors {
  const errors: Errors = {};
  for (const [field, v] of [['email', email], ['password', password]] as const) {
    if (!required(v)) add(errors, field, 'validation.required');
    else if (typeof v !== 'string') add(errors, field, 'validation.string');
  }
  return errors;
}

// RegisterController::validator: name required|max:255, email required|email|max:255|unique:users,
// password required|min:6|confirmed.
export async function registerValidation(data: Record<string, unknown>): Promise<Errors> {
  const errors: Errors = {};
  const { name, email, password } = data;
  if (!required(name)) add(errors, 'name', 'validation.required');
  else if (typeof name === 'string' && name.length > 255) add(errors, 'name', 'validation.max.string', { max: 255 });
  if (!required(email)) add(errors, 'email', 'validation.required');
  else {
    checkEmail(errors, email);
    if (typeof email === 'string' && email.length > 255) add(errors, 'email', 'validation.max.string', { max: 255 });
    if (typeof email === 'string') {
      const existing = await db.selectFrom('os_users').select('id').where('email', '=', email).executeTakeFirst();
      if (existing) add(errors, 'email', 'validation.unique');
    }
  }
  if (!required(password)) add(errors, 'password', 'validation.required');
  else {
    checkPasswordMin(errors, password);
    checkConfirmed(errors, data);
  }
  return errors;
}

// ResetsPasswords::rules: token required, email required|email, password required|confirmed|min:6.
export function resetValidation(data: Record<string, unknown>): Errors {
  const errors: Errors = {};
  if (!required(data['token'])) add(errors, 'token', 'validation.required');
  if (!required(data['email'])) add(errors, 'email', 'validation.required');
  else checkEmail(errors, data['email']);
  if (!required(data['password'])) add(errors, 'password', 'validation.required');
  else {
    checkConfirmed(errors, data);
    checkPasswordMin(errors, data['password']);
  }
  return errors;
}

// SendsPasswordResetEmails::validateEmail: email required|email.
export function emailValidation(email: unknown): Errors {
  const errors: Errors = {};
  if (!required(email)) add(errors, 'email', 'validation.required');
  else checkEmail(errors, email);
  return errors;
}

// ---------------------------------------------------------------- password broker

// config('auth.passwords.users'): table password_resets (os_ prefixed), expire 60 min.
const RESET_EXPIRE_MINUTES = 60;

// SAFETY: Kysely types timestamp columns as Date, but mysql2 sends the
// 'YYYY-MM-DD HH:mm:ss' string through unchanged (same value Laravel writes).
function nowTimestamp(): Date {
  return nowDb() as unknown as Date;
}

function resetToken(): string {
  // DatabaseTokenRepository::createNewToken(): hash_hmac('sha256', random 40, app key)
  return createHmac('sha256', config.APP_KEY).update(randomBytes(20).toString('binary')).digest('hex');
}

// PasswordBroker::sendResetLink: returns the passwords.* lang key (INVALID_USER / RESET_LINK_SENT).
export async function sendResetLink(email: string): Promise<'passwords.user' | 'passwords.sent'> {
  const user = await db.selectFrom('os_users').select('id').where('email', '=', email).executeTakeFirst();
  if (!user) return 'passwords.user';
  // DatabaseTokenRepository::create: delete the user's tokens, store the bcrypt-hashed token.
  const token = resetToken();
  await db.deleteFrom('os_password_resets').where('email', '=', email).execute();
  await db
    .insertInto('os_password_resets')
    .values({ email, token: hashPassword(token), created_at: nowTimestamp() })
    .execute();
  // sendPasswordResetNotification: never sent here; MAIL_ENABLED=1 only logs the link.
  if (process.env.MAIL_ENABLED === '1') {
    console.log(`[mail] password reset link for ${email}: ${config.APP_URL}/password/reset/${token}?email=${encodeURIComponent(email)}`);
  }
  return 'passwords.sent';
}

// PasswordBroker::reset: returns the passwords.* lang key plus the user id on success.
export async function resetPassword(data: Record<string, unknown>): Promise<{ key: string; userId?: number }> {
  const email = String(data['email']);
  const user = await db.selectFrom('os_users').select('id').where('email', '=', email).executeTakeFirst();
  if (!user) return { key: 'passwords.user' };
  const password = data['password'];
  if (typeof password !== 'string' || password.length < 6 || password !== data['password_confirmation']) return { key: 'passwords.password' };
  const row = await db.selectFrom('os_password_resets').select(['token', 'created_at']).where('email', '=', email).executeTakeFirst();
  const createdAt = row ? new Date(String(row.created_at).replace(' ', 'T')).getTime() : 0;
  if (!row || createdAt + RESET_EXPIRE_MINUTES * 60_000 <= Date.now() || !verifyPassword(String(data['token']), row.token)) {
    return { key: 'passwords.token' };
  }
  await db
    .updateTable('os_users')
    .set({ password: hashPassword(password), remember_token: randomBytes(30).toString('hex'), updated_at: nowTimestamp() })
    .where('id', '=', user.id)
    .execute();
  await db.deleteFrom('os_password_resets').where('email', '=', email).execute();
  return { key: 'passwords.reset', userId: user.id };
}
