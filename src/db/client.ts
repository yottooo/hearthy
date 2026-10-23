import pg from 'pg';
import { redactUrl } from '../config.js';
import { HearthyError, isConnectionRefused } from '../errors.js';

export type Pool = pg.Pool;

/** Opens a pool and checks the database is reachable, with a helpful error if it isn't. */
export async function connect(databaseUrl: string): Promise<Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end();
    if (isConnectionRefused(err)) {
      throw new HearthyError(
        `Cannot reach Postgres at ${redactUrl(databaseUrl)}.\n` +
          'Start it with: npm run db:up (requires Docker Desktop).',
        { cause: err },
      );
    }
    throw err;
  }
}
