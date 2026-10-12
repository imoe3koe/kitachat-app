const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL belum dikonfigurasi.');
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Math.max(1, Number(process.env.DB_POOL_MAX) || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  family: 4,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

pool.on('error', error => {
  console.warn('Koneksi PostgreSQL idle terputus:', error.code || error.message);
});

async function setupDatabase() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Pembuatan Tabel Utama (Termasuk family_code pada tabel agendas)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        password VARCHAR(255) NOT NULL,
        birthdate DATE,
        photo_url TEXT,
        session_token TEXT,
        email VARCHAR(255) UNIQUE,
        family_code VARCHAR(50),
        is_head BOOLEAN DEFAULT FALSE,
        reset_token VARCHAR(255),
        reset_token_expiry BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS albums (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        caption TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agendas (
        id SERIAL PRIMARY KEY,
        family_code VARCHAR(50),
        title VARCHAR(150) NOT NULL,
        event_date DATE NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        family_code VARCHAR(50),
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT,
        image_url TEXT,
        sticker_url TEXT,
        audio_url TEXT,
        reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        client_time VARCHAR(50)
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Migrasi Kolom Tambahan (Untuk keamanan jika tabel sudah ada sebelumnya)
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS family_code VARCHAR(50)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_head BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiry BIGINT');
    await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS family_code VARCHAR(50)');
    await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INT');
    await client.query('ALTER TABLE agendas ADD COLUMN IF NOT EXISTS family_code VARCHAR(50)');

    // 3. Pembuatan Indeks untuk Performa Kueri
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_family_code ON messages(family_code)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON messages(reply_to_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_albums_created_at ON albums(created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_albums_user_id ON albums(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_session_token ON users(session_token)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_family_code ON users(family_code)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_agendas_event_date ON agendas(event_date)');

    await client.query('COMMIT');
    console.log('Schema database Kitachat berhasil dibuat dan diperbarui.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Gagal membuat atau memperbarui database:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(error => {
      console.error('Gagal menutup koneksi database:', error.message);
      process.exitCode = 1;
    });
  }
}

setupDatabase().catch(async error => {
  console.error('Inisialisasi database gagal:', error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});