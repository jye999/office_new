import { Kysely, MysqlDialect, sql } from 'kysely';
import mysql from 'mysql2';
import { config } from './config.js';

export { sql };

// Laravel's mysql connection prefixes office tables with `os_` (raw SQL is not prefixed).
// The generated `OfficeDatabase` type uses the real table names, so code queries
// `db.selectFrom('os_products')` etc. — no prefix translation needed at runtime.
// mysql2 `timezone: 'local'` matches config/database.php (no `timezone` key).
const mysqlOptions = {
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USERNAME,
  password: config.DB_PASSWORD,
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  timezone: 'local' as const,
};

const officePool = mysql.createPool({ ...mysqlOptions, database: config.DB_DATABASE });
const hwcPool = mysql.createPool({ ...mysqlOptions, database: config.DB_HWC_DATABASE });

export type OfficeDatabase = import('./db/office.js').DB;
export type HwcDatabase = import('./db/hwc.js').DB;

export const db = new Kysely<OfficeDatabase>({ dialect: new MysqlDialect({ pool: officePool }) });
export const hwc = new Kysely<HwcDatabase>({ dialect: new MysqlDialect({ pool: hwcPool }) });

// Eloquent timestamps use this format in the app timezone.
export function nowDb(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .format(date)
    .replace(/T|, /g, ' ')
}
