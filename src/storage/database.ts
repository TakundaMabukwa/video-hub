import { Pool, QueryResult } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ========== CONNECTION POOL CONFIGURATION ==========
// Optimized for high-concurrency scenarios (370+ cameras)
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'video_system',
  user: process.env.DB_USER || 'postgres',
  password: String(process.env.DB_PASSWORD || ''),
  
  // CONNECTION POOL TUNING
  max: parseInt(process.env.DB_POOL_MAX || '100'),              // was 20, now 100 (for 370+ cameras)
  min: parseInt(process.env.DB_POOL_MIN || '10'),               // new: maintain minimum connections
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '5000'),  // was 30s, now 5s (aggressive reclaim)
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '5000'), // was 2s, now 5s
  
  // CONNECTION VALIDATION
  idleConnectionTestInterval: parseInt(process.env.DB_IDLE_TEST_INTERVAL || '10000'), // new: validate idle connections every 10s
  maxUses: parseInt(process.env.DB_MAX_USES || '7500'),         // new: cycle connections after 7500 uses
  
  // QUERY TIMEOUT (kill queries after 30 seconds)
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000'),
  
  // CONNECTION VALIDATION QUERIES
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
});

// ========== CONNECTION POOL EVENT HANDLERS ==========
pool.on('error', (err) => {
  console.error('❌ Database Pool Error:', err.message);
});

pool.on('connect', () => {
  // Reset statement timeout on each connection
  pool.query(`SET statement_timeout = '${process.env.DB_STATEMENT_TIMEOUT || '30000'}'`).catch(err => {
    console.warn('⚠️ Failed to set statement timeout:', err.message);
  });
});

// Monitor pool exhaustion
pool.on('ready', () => {
  console.log('✅ Database pool ready');
});

// ========== WRAPPED QUERY WITH TIMEOUT & ERROR HANDLING ==========
export const query = async (text: string, params?: any[]): Promise<QueryResult<any>> => {
  const startTime = Date.now();
  
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - startTime;
    
    // Log slow queries (> 5 seconds)
    if (duration > 5000) {
      console.warn(`⏱️ Slow query (${duration}ms): ${text.substring(0, 50)}...`);
    }
    
    return result;
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`❌ Query failed (${duration}ms):`, error.message);
    throw error;
  }
};

// ========== GET POOL STATS ==========
export const getPoolStats = () => ({
  waiting: pool.waitingCount,
  idle: pool.idleCount,
  active: pool.totalCount - pool.idleCount,
  total: pool.totalCount,
  max: pool.options.max
});

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
    `ALTER TABLE IF EXISTS videos ADD COLUMN IF NOT EXISTS frame_count INTEGER`,

    // indexes used heavily by alert media routes
    `CREATE INDEX IF NOT EXISTS idx_images_alert_id ON images(alert_id)`,
    `CREATE INDEX IF NOT EXISTS idx_images_device_timestamp ON images(device_id, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_alert_id ON videos(alert_id)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_device_start_time ON videos(device_id, start_time DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_device_channel_start_time ON videos(device_id, channel, start_time DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_device_channel_end_time ON videos(device_id, channel, end_time DESC)`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
};

// ========== GRACEFUL SHUTDOWN ==========
export const closePool = async (): Promise<void> => {
  console.log('🔌 Closing database pool...');
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (error: any) {
    console.error('❌ Error closing pool:', error.message);
  }
};

// ========== POOL MONITORING ==========
// Log pool stats every 60 seconds
setInterval(() => {
  const stats = getPoolStats();
  if (stats.waiting > 0 || stats.active > stats.max * 0.8) {
    console.warn(`⚠️ DB Pool Status: waiting=${stats.waiting}, active=${stats.active}, idle=${stats.idle}, total=${stats.total}/${stats.max}`);
  }
}, 60000);

export default pool;
