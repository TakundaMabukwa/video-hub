import * as fs from 'fs';
import * as path from 'path';
import { query } from './database';
import { execSync } from 'child_process';

type PruneStats = {
  deletedFiles: number;
  deletedBytes: number;
  deletedDbRows: number;
};

export class RetentionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly checkIntervalMs = Math.max(60_000, Number(process.env.RETENTION_CHECK_INTERVAL_MS || 10 * 60_000));
  private readonly maxDiskUsePct = Math.max(1, Math.min(99, Number(process.env.MAX_DISK_USE_PERCENT || 85)));
  private readonly emergencyDiskUsePct = Math.max(this.maxDiskUsePct + 1, Math.min(99, Number(process.env.EMERGENCY_DISK_USE_PERCENT || 92)));
  private readonly keepAlertDays = Math.max(1, Number(process.env.RETENTION_ALERT_DAYS || 14));
  private readonly keepManualDays = Math.max(0, Number(process.env.RETENTION_MANUAL_DAYS || 2));
  private readonly keepEvidenceDays = Math.max(0, Number(process.env.RETENTION_EVIDENCE_DAYS || 2));
  private readonly keepTranscodedDays = Math.max(0, Number(process.env.RETENTION_TRANSCODED_DAYS || 2));
  private readonly keepHlsHours = Math.max(1, Number(process.env.RETENTION_HLS_HOURS || 72));
  private readonly keepLiveHours = Math.max(1, Number(process.env.RETENTION_LIVE_HOURS || 72));
  private readonly keepRawLogHours = Math.max(1, Number(process.env.RETENTION_RAW_LOG_HOURS || 24));

  start(): void {
    if (this.timer) return;
    this.runOnce().catch(() => {});
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const disk = this.getRootDiskUsagePercent();
      const emergency = disk >= this.emergencyDiskUsePct;
      const constrained = disk >= this.maxDiskUsePct;
      const now = Date.now();

      const stats: PruneStats = { deletedFiles: 0, deletedBytes: 0, deletedDbRows: 0 };

      stats.deletedDbRows += await this.pruneOrphanVideoRows();
      stats.deletedDbRows += await this.pruneLiveVideoRows(now - this.keepLiveHours * 3600_000, stats);
      this.pruneByAge(path.join(process.cwd(), 'hls'), now - this.keepHlsHours * 3600_000, stats);
      this.pruneByAge(path.join(process.cwd(), 'recordings', 'transcoded'), now - this.keepTranscodedDays * 24 * 3600_000, stats);
      this.pruneByAge(path.join(process.cwd(), 'logs', 'raw-ingest.ndjson'), now - this.keepRawLogHours * 3600_000, stats, true);

      if (constrained || emergency) {
        this.pruneManualAndEvidence(now, stats, emergency);
      }

      if (emergency) {
        // Last line of defense: trim all non-alert live capture files older than 6h.
        this.pruneNonAlertRecordings(now - 6 * 3600_000, stats);
      }

      if (stats.deletedFiles > 0 || stats.deletedDbRows > 0) {
        console.log(
          `Retention cleanup: files=${stats.deletedFiles}, bytes=${stats.deletedBytes}, dbRows=${stats.deletedDbRows}, disk=${disk.toFixed(1)}%`
        );
      }
    } catch (err: any) {
      console.error('Retention cleanup failed:', err?.message || err);
    } finally {
      this.running = false;
    }
  }

  private getRootDiskUsagePercent(): number {
    try {
      if (process.platform === 'win32') return 0;
      const out = String(execSync('df -P / | tail -1 | awk \'{print $5}\'', { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
      const pct = Number(out.replace('%', ''));
      if (Number.isFinite(pct) && pct >= 0) return pct;
    } catch {}
    return Number(process.env.FORCE_DISK_USAGE_PERCENT || 0);
  }

  private pruneManualAndEvidence(nowMs: number, stats: PruneStats, emergency: boolean): void {
    const manualCutoff = nowMs - (emergency ? 12 : this.keepManualDays * 24) * 3600_000;
    const evidenceCutoff = nowMs - (emergency ? 12 : this.keepEvidenceDays * 24) * 3600_000;

    const recordingsRoot = path.join(process.cwd(), 'recordings');
    if (!fs.existsSync(recordingsRoot)) return;
    for (const vehicleId of fs.readdirSync(recordingsRoot)) {
      const base = path.join(recordingsRoot, vehicleId);
      this.pruneByAge(path.join(base, 'manual'), manualCutoff, stats);
      this.pruneByAge(path.join(base, 'evidence'), evidenceCutoff, stats);
    }
  }

  private pruneNonAlertRecordings(cutoffMs: number, stats: PruneStats): void {
    const recordingsRoot = path.join(process.cwd(), 'recordings');
    if (!fs.existsSync(recordingsRoot)) return;
    for (const vehicleId of fs.readdirSync(recordingsRoot)) {
      const base = path.join(recordingsRoot, vehicleId);
      const alertsDir = path.join(base, 'alerts');
      for (const entry of fs.readdirSync(base)) {
        const full = path.join(base, entry);
        if (full === alertsDir) continue;
        this.pruneByAge(full, cutoffMs, stats);
      }
    }
  }

  private pruneByAge(targetPath: string, cutoffMs: number, stats: PruneStats, isFile = false): void {
    if (!fs.existsSync(targetPath)) return;
    const walk = (p: string) => {
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(p)) walk(path.join(p, e));
        return;
      }
      if (st.mtimeMs > cutoffMs) return;
      try {
        const size = st.size || 0;
        fs.unlinkSync(p);
        stats.deletedFiles += 1;
        stats.deletedBytes += size;
      } catch {}
    };

    if (isFile) {
      walk(targetPath);
      return;
    }
    walk(targetPath);
  }

  private async pruneOrphanVideoRows(): Promise<number> {
    const res = await query(
      `SELECT id, file_path, alert_id, storage_url
       FROM videos
       WHERE (storage_url IS NULL OR storage_url = '' OR storage_url = 'local-only' OR storage_url = 'upload-failed')`
    );
    const staleIds: string[] = [];
    for (const row of res.rows || []) {
      const p = String(row.file_path || '');
      const alertId = row.alert_id ? String(row.alert_id) : '';
      if (alertId) continue; // never prune alert-linked DB rows here
      if (!p) {
        staleIds.push(String(row.id));
        continue;
      }
      const exists = fs.existsSync(path.isAbsolute(p) ? p : path.join(process.cwd(), p));
      if (!exists) staleIds.push(String(row.id));
    }
    if (staleIds.length === 0) return 0;
    await query(`DELETE FROM videos WHERE id = ANY($1::uuid[])`, [staleIds]);
    return staleIds.length;
  }

  private removePlayableVariants(filePath: string, stats: PruneStats): void {
    try {
      const parsed = path.parse(filePath);
      const dir = parsed.dir;
      const prefix = `${parsed.name}.`;
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.playable.mp4')) continue;
        const full = path.join(dir, entry);
        if (!fs.existsSync(full)) continue;
        const st = fs.statSync(full);
        fs.unlinkSync(full);
        stats.deletedFiles += 1;
        stats.deletedBytes += st.size || 0;
      }
    } catch {}
  }

  private async pruneLiveVideoRows(cutoffMs: number, stats: PruneStats): Promise<number> {
    const cutoff = new Date(cutoffMs);
    const res = await query(
      `SELECT id, file_path, storage_url
       FROM videos
       WHERE video_type = 'live'
         AND alert_id IS NULL
         AND COALESCE(end_time, start_time) < $1`,
      [cutoff]
    );

    const deleteIds: string[] = [];
    for (const row of res.rows || []) {
      const rawPath = String(row.file_path || '').trim();
      const localPath = rawPath
        ? (path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath))
        : '';
      if (localPath && fs.existsSync(localPath)) {
        try {
          const st = fs.statSync(localPath);
          fs.unlinkSync(localPath);
          stats.deletedFiles += 1;
          stats.deletedBytes += st.size || 0;
          this.removePlayableVariants(localPath, stats);
        } catch {}
      }
      deleteIds.push(String(row.id));
    }

    if (deleteIds.length === 0) return 0;
    await query(`DELETE FROM videos WHERE id = ANY($1::uuid[])`, [deleteIds]);
    return deleteIds.length;
  }
}
