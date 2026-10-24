import { createHash, randomBytes } from 'node:crypto';
import { db, hwc, nowDb } from '../db.js';

const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function createPdaKey(random: Buffer = randomBytes(48)): string {
  return Array.from(random, (byte) => alphabet[byte % alphabet.length]).join('');
}

export async function replacePdaApiKey(userInput: string): Promise<string | null> {
  const user = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(userInput)
    ? await db.selectFrom('os_users').select('id').where('id', '=', Number(userInput)).executeTakeFirst()
    : await db.selectFrom('os_users').select('id').where('email', '=', userInput).executeTakeFirst();
  if (!user) return null;

  const plain = createPdaKey();
  const values = {
    name: 'pda',
    token_hash: createHash('sha256').update(plain).digest('hex'),
    token_hint: plain.slice(0, 10),
    // SAFETY: generated DB timestamps are typed Date but Laravel writes this string unchanged.
    updated_at: nowDb() as unknown as Date,
  };
  const existing = await db.selectFrom('os_user_api_tokens').select('id').where('user_id', '=', user.id).executeTakeFirst();
  if (existing) await db.updateTable('os_user_api_tokens').set(values).where('id', '=', existing.id).execute();
  else await db.insertInto('os_user_api_tokens').values({ ...values, user_id: user.id, created_at: values.updated_at }).execute();
  return plain;
}

const user = process.argv[2];
try {
  const key = user ? await replacePdaApiKey(user) : null;
  if (!key) {
    console.error('User not found.');
    process.exitCode = 1;
  } else {
    console.log(key);
    console.warn('Store this key securely; it is only shown here once. Any previous PDA key for this user is invalid.');
  }
} finally {
  await db.destroy();
  await hwc.destroy();
}
