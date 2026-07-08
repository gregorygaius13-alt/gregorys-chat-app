import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL || '').includes('localhost') ? false : { rejectUnauthorized: false }
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_reads (
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id INTEGER,
      PRIMARY KEY (room_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Photo / voice-note attachments (added later — safe to run on an existing database)
  await pool.query(`ALTER TABLE messages ALTER COLUMN text DROP NOT NULL;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;`);
  // Admin role, used to let one trusted person reset a family member's password
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;`);
  await pool.query(`
    UPDATE users SET is_admin = true
    WHERE id = (SELECT MIN(id) FROM users)
    AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = true);
  `);
  // Profile pictures
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  // Private 1-to-1 chats — a room with rows here is restricted to just those members;
  // a room with no rows here is a normal, everyone-can-see-it group room.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (room_id, user_id)
    );
  `);
  const { rows } = await pool.query('SELECT COUNT(*) FROM rooms');
  if (parseInt(rows[0].count, 10) === 0) {
    await pool.query("INSERT INTO rooms (name) VALUES ('Family Group')");
  }
  // Live/Status posts — temporary updates that disappear after 24 hours
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      text TEXT,
      media_url TEXT,
      media_type TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_views (
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      viewed_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (post_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_reactions (
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      reaction TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (post_id, user_id)
    );
  `);
}

export default pool;
