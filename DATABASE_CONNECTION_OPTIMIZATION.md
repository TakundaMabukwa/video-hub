# PostgreSQL Connection Pool Optimization

## Problem: "Too Many Connections" Timeout

PostgreSQL has a maximum connection limit (usually 100-200 by default). When your application exhausts this limit or creates connections inefficiently, you get:
- `too many connections` errors
- Connection timeouts
- Queries waiting indefinitely in queue

## Solution Implemented

### 1. **Increased Connection Pool Size** 
**Before:** `max: 20` connections  
**After:** `max: 100` connections (configurable via `DB_POOL_MAX`)

For 370+ cameras pushing constant data, a pool of 20 is undersized. At peak load, all 20 connections get occupied immediately.

```env
# .env
DB_POOL_MAX=100    # Adjust based on server resources and expected concurrent queries
DB_POOL_MIN=10     # Keep minimum connections alive
```

### 2. **Aggressive Idle Connection Reclamation**
**Before:** `idleTimeoutMillis: 30000` (30 seconds)  
**After:** `idleTimeoutMillis: 5000` (5 seconds, configurable via `DB_IDLE_TIMEOUT`)

Idle connections hold open database connections unnecessarily. By aggressively reclaiming them after 5 seconds, you prevent connection buildup.

```env
DB_IDLE_TIMEOUT=5000    # Kill idle connections after 5 seconds
```

### 3. **Statement Timeout (Prevent Hanging Queries)**
**Before:** None (queries could hang forever)  
**After:** `30000ms` (30 seconds, configurable via `DB_STATEMENT_TIMEOUT`)

Long-running or stuck queries can hold connections. With a statement timeout, PostgreSQL automatically kills queries that exceed this limit, freeing the connection.

```env
DB_STATEMENT_TIMEOUT=30000    # Kill queries exceeding 30 seconds
```

### 4. **Connection Validation & Cycling**
**New:** `idleConnectionTestInterval: 10000` - Validates idle connections every 10 seconds  
**New:** `maxUses: 7500` - Cycles connections after 7500 uses to prevent stale connections

PostgreSQL can close idle connections on its end. By periodically testing them and cycling old connections, you prevent "connection closed by server" errors.

```env
DB_IDLE_TEST_INTERVAL=10000   # Test idle connections every 10 seconds
DB_MAX_USES=7500              # Recycle connections after N uses
```

### 5. **Query Timeout Wrapper**
Added a wrapped `query()` function that:
- Logs slow queries (> 5 seconds) for debugging
- Captures query duration
- Provides better error messages

### 6. **Pool Monitoring & Logging**
- Pool stats logged every 60 seconds: `waiting`, `active`, `idle`, `total`
- Warnings when pool exceeds 80% utilization
- New endpoints: `/health` and `/api/db/pool-status` for real-time monitoring

### 7. **Graceful Shutdown**
Added proper database pool cleanup on server shutdown (SIGINT/SIGTERM) to prevent hanging connections.

---

## Configuration

### Environment Variables

```env
# Connection Pool
DB_POOL_MAX=100                    # Maximum concurrent connections (default: 100)
DB_POOL_MIN=10                     # Minimum idle connections to maintain (default: 10)
DB_IDLE_TIMEOUT=5000               # Kill idle connections after 5 seconds (default: 5000)
DB_CONNECTION_TIMEOUT=5000         # Timeout for acquiring a connection (default: 5000)
DB_IDLE_TEST_INTERVAL=10000        # Test idle connections every 10 seconds (default: 10000)
DB_MAX_USES=7500                   # Recycle connections after N uses (default: 7500)
DB_STATEMENT_TIMEOUT=30000         # Kill queries exceeding 30 seconds (default: 30000)

# Database Connection
DB_HOST=your_postgres_host
DB_PORT=5432
DB_NAME=video_system
DB_USER=video_user
DB_PASSWORD=your_password
```

### Tuning for Different Scenarios

#### **Small Setup (1-10 cameras)**
```env
DB_POOL_MAX=20
DB_POOL_MIN=5
DB_IDLE_TIMEOUT=10000    # 10 seconds
DB_STATEMENT_TIMEOUT=30000
```

#### **Medium Setup (10-100 cameras)**
```env
DB_POOL_MAX=50
DB_POOL_MIN=10
DB_IDLE_TIMEOUT=5000     # 5 seconds
DB_STATEMENT_TIMEOUT=30000
```

#### **Large Setup (100-370+ cameras)** [DEFAULT]
```env
DB_POOL_MAX=100
DB_POOL_MIN=10
DB_IDLE_TIMEOUT=5000     # 5 seconds
DB_STATEMENT_TIMEOUT=30000
```

#### **High-Throughput Setup (370+ cameras with heavy dashboard traffic)**
```env
DB_POOL_MAX=150
DB_POOL_MIN=20
DB_IDLE_TIMEOUT=3000     # 3 seconds (more aggressive)
DB_STATEMENT_TIMEOUT=20000  # Lower timeout for faster failure detection
```

---

## Monitoring

### Real-Time Pool Status

Check the database connection pool status:

```bash
# View health + database stats
curl http://localhost:3000/health | jq '.database'

# Detailed pool status
curl http://localhost:3000/api/db/pool-status | jq '.'
```

### Server Logs

Watch for pool warnings:

```bash
pm2 logs video-server | grep "DB Pool"
pm2 logs video-server | grep "Slow query"
pm2 logs video-server | grep "warning"
```

### Example Output

When utilization is high, you'll see:
```
⚠️ DB Pool Status: waiting=2, active=95, idle=5, total=100/100
⏱️ Slow query (6234ms): SELECT * FROM videos WHERE...
```

---

## Troubleshooting

### Still Getting "Too Many Connections"?

1. **Check current pool status:**
   ```bash
   curl http://localhost:3000/api/db/pool-status | jq '.'
   ```

2. **Increase pool size:**
   ```env
   DB_POOL_MAX=150  # Or higher if server resources allow
   ```

3. **Check for connection leaks** (queries waiting > 60 seconds):
   ```bash
   pm2 logs video-server | grep "waiting"
   ```
   If `waiting` is consistently > 5, reduce `DB_IDLE_TIMEOUT` further or increase `DB_POOL_MAX`.

4. **Kill hanging queries in PostgreSQL:**
   ```sql
   SELECT pid, usename, query, state FROM pg_stat_activity 
   WHERE state = 'active' AND query_start < NOW() - INTERVAL '5 minutes';
   
   -- Kill specific query
   SELECT pg_terminate_backend(pid);
   ```

5. **Check PostgreSQL max_connections**:
   ```sql
   psql -h your_host -U video_user -d video_system -c "SHOW max_connections;"
   ```
   
   If too low, increase it:
   ```sql
   ALTER SYSTEM SET max_connections = 300;
   SELECT pg_reload_conf();
   ```

### Queries Timing Out?

- Increase `DB_STATEMENT_TIMEOUT`:
  ```env
  DB_STATEMENT_TIMEOUT=60000  # 60 seconds instead of 30
  ```

- Check query performance:
  ```sql
  EXPLAIN ANALYZE SELECT ... FROM videos WHERE ...;
  ```

- Ensure indexes exist on frequently queried columns.

### Connection Pool Thrashing (High Churn)?

- Increase `DB_IDLE_TIMEOUT` (keep connections alive longer):
  ```env
  DB_IDLE_TIMEOUT=10000  # 10 seconds instead of 5
  ```

- Increase `DB_POOL_MIN` (maintain more idle connections):
  ```env
  DB_POOL_MIN=20  # Pre-allocate more connections
  ```

---

## Before/After Comparison

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Max Pool Size | 20 | 100 | 5x increase |
| Idle Timeout | 30s | 5s | 6x faster reclamation |
| Hanging Queries | Unlimited | 30s max | Prevents stalls |
| Connection Validation | None | Every 10s | Detects stale connections |
| Monitoring | None | Auto-logs + endpoints | Full visibility |
| Graceful Shutdown | No | Yes | Prevents orphaned connections |

---

## Additional Optimizations

### 1. Database Query Optimization
Review slow queries and add indexes:

```sql
-- Example indexes for common queries
CREATE INDEX idx_alerts_device_timestamp ON alerts(device_id, timestamp DESC);
CREATE INDEX idx_videos_device_start_time ON videos(device_id, start_time DESC);
CREATE INDEX idx_images_alert_id ON images(alert_id);
```

### 2. Connection Best Practices in Code

✅ **Good:**
```typescript
const result = await pool.query(sql, params);  // Returns connection to pool
```

❌ **Bad:**
```typescript
const client = await pool.connect();
// Forgot to call client.release() - connection leaks!
```

### 3. PostgreSQL Server Tuning

```bash
# /etc/postgresql/*/main/postgresql.conf

# Increase connection limit
max_connections = 300

# Increase connection pre-allocation
max_prepared_transactions = 250

# Improve query performance
max_parallel_workers_per_gather = 4
max_parallel_workers = 8
```

---

## Files Modified

- **[src/storage/database.ts](src/storage/database.ts)** - Connection pool configuration & monitoring
- **[src/index.ts](src/index.ts)** - Graceful shutdown + health/status endpoints

## Next Steps

1. Deploy with new configuration
2. Monitor pool status via `/api/db/pool-status` 
3. Adjust `DB_POOL_MAX` based on utilization
4. Set up alerts if utilization exceeds 80%
