import { Pool, QueryResult, PoolClient } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ========== CONNECTION POOL CONFIGURATION ==========
// OPTIMIZED FOR: PostgreSQL max_connections = 300 + shared_buffers = 4GB + 16GB RAM
// Increased pool size to handle 370+ cameras with spikes
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'video_system',
  user: process.env.DB_USER || 'postgres',
  password: String(process.env.DB_PASSWORD || ''),
  
  // CONNECTION POOL TUNING - BALANCED FOR HIGH LOAD
  max: parseInt(process.env.DB_POOL_MAX || '150'),              // 150 = safe under 300 limit (leaves 150 for buffer)
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '4000'),  // Kill idle connections after 4 seconds
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000'), // 10s timeout for acquiring connection
  
  // CONNECTION REUSE/CYCLING
  connectionIdleTimeout: parseInt(process.env.DB_CONNECTION_IDLE_TIMEOUT || '1800000'), // 30 min: recycle old connections
  maxUses: parseInt(process.env.DB_MAX_USES || '2000'),         // Recycle connection after 2000 queries
});

// ========== CONNECTION POOL EVENT HANDLERS ==========
pool.on('error', (err: Error) => {
  console.error('❌ Database Pool Error:', err.message);
});

pool.on('connect', (client: PoolClient) => {
  // Set statement timeout on each connection to kill long-running queries (30 seconds)
  client.query(`SET statement_timeout = '${process.env.DB_STATEMENT_TIMEOUT || '30000'}'`).catch(err => {
    console.warn('⚠️ Failed to set statement timeout:', err.message);
  });
});

// ========== WRAPPED QUERY WITH WAITING & RETRY LOGIC ==========
// Automatically waits and retries if no connections available
export const query = async (
  text: string,
  params?: any[],
  retryCount = 0,
  maxRetries = 3
): Promise<QueryResult<any>> => {
  const startTime = Date.now();
  const waitStartTime = startTime;
  
  try {
    // Attempt to acquire connection and execute query
    const result = await pool.query(text, params);
    const duration = Date.now() - startTime;
    
    // Log slow queries (> 5 seconds)
    if (duration > 5000) {
      console.warn(`⏱️ Slow query (${duration}ms): ${text.substring(0, 50)}...`);
    }
    
    return result;
  } catch (error: any) {
    const duration = Date.now() - startTime;
    const errorMsg = error.message || String(error);
    
    // Handle "too many clients already" with exponential backoff retry
    if (
      (errorMsg.includes('too many clients already') || 
       errorMsg.includes('FATAL') ||
       errorMsg.includes('connect ECONNREFUSED')) &&
      retryCount < maxRetries
    ) {
      const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 5000); // Up to 5 second backoff
      console.warn(
        `⚠️ Connection pool busy (attempt ${retryCount + 1}/${maxRetries}), ` +
        `waiting ${backoffMs}ms before retry...`
      );
      
      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return query(text, params, retryCount + 1, maxRetries);
    }
    
    // Log errors
    console.error(`❌ Query failed (${duration}ms):`, errorMsg);
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

// ========== POOL MONITORING - AGGRESSIVE FOR BUSY SERVER ==========
// Log pool stats every 30 seconds (more frequent monitoring for busy server)
// Alert if pool is getting exhausted
setInterval(() => {
  const stats = getPoolStats();
  const utilizationPercent = Math.round((stats.active / stats.max) * 100);
  
  // CRITICAL: Waiting queries = connections exhausted
  if (stats.waiting > 0) {
    console.error(
      `🚨 CRITICAL: ${stats.waiting} queries WAITING for connection! ` +
      `Active=${stats.active}/${stats.max} (${utilizationPercent}%)`
    );
  }
  
  // WARNING: Pool over 75% utilized
  if (stats.active > stats.max * 0.75) {
    console.warn(
      `⚠️ DB Pool High Utilization: ${utilizationPercent}% ` +
      `(${stats.active}/${stats.max}), idle=${stats.idle}`
    );
  }
  
  // INFO: Normal operation
  if (stats.waiting === 0 && stats.active <= stats.max * 0.75) {
    // Only log periodically in normal operation to reduce noise
    if (Math.random() < 0.1) { // Log 10% of the time
      console.log(
        `✅ DB Pool OK: ${utilizationPercent}% utilized ` +
        `(${stats.active}/${stats.max}), idle=${stats.idle}, waiting=${stats.waiting}`
      );
    }
  }
}, 30000);

export default pool;
