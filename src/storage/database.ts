import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'video_system',
  user: process.env.DB_USER || 'postgres',
  password: String(process.env.DB_PASSWORD || ''),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Database error:', err);
});

export const query = (text: string, params?: any[]) => pool.query(text, params);

export const ensureRuntimeSchema = async (): Promise<void> => {
  const statements: string[] = [
    // alerts table compatibility
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS closure_type TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS closure_subtype TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS resolution_notes TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS resolved_by TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS resolution_reason_code TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS resolution_reason_label TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS ncr_document_url TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS ncr_document_name TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS report_document_url TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS report_document_name TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS report_document_type TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS is_false_alert BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS false_alert_reason TEXT`,
    `ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS false_alert_reason_code TEXT`,

    // images table compatibility for alert-linked screenshots
    `ALTER TABLE IF EXISTS images ADD COLUMN IF NOT EXISTS storage_url TEXT`,
    `ALTER TABLE IF EXISTS images ADD COLUMN IF NOT EXISTS file_size BIGINT`,
    `ALTER TABLE IF EXISTS images ADD COLUMN IF NOT EXISTS alert_id TEXT`,

    // videos table compatibility for alert-linked clips
    `ALTER TABLE IF EXISTS videos ADD COLUMN IF NOT EXISTS storage_url TEXT`,
    `ALTER TABLE IF EXISTS videos ADD COLUMN IF NOT EXISTS alert_id TEXT`,

    // indexes used heavily by alert media routes
    `CREATE INDEX IF NOT EXISTS idx_images_alert_id ON images(alert_id)`,
    `CREATE INDEX IF NOT EXISTS idx_images_device_timestamp ON images(device_id, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_alert_id ON videos(alert_id)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_device_start_time ON videos(device_id, start_time DESC)`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
};

export default pool;
