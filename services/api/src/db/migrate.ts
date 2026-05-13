import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Check if already migrated
    const res = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
      ) as migrated
    `);
    if (res.rows[0].migrated) {
      console.log('[DB] Schema already applied, skipping migration');
      return;
    }

    console.log('[DB] Running schema migration...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('[DB] ✅ Schema applied successfully');
  } finally {
    client.release();
  }
}
