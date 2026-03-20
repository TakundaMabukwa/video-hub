import { query } from './database';
import { ensureBucket, getSupabase, hasSupabaseStorage } from './supabase';
import * as fs from 'fs';
import { isDatabaseEnabled } from './database';

export class VideoStorage {
  private bucketReady: Promise<string>;
  private readonly dbEnabled: boolean;

  constructor() {
    this.dbEnabled = isDatabaseEnabled();
    this.bucketReady = ensureBucket();
  }

  private async ensureDeviceExists(deviceId: string): Promise<void> {
    if (!this.dbEnabled) return;
    if (!deviceId) return;

    const looksLikeIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(deviceId);
    const ipAddress = looksLikeIp ? deviceId : null;

    await query(
      `INSERT INTO devices (device_id, ip_address, last_seen)
       VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         ip_address = COALESCE(EXCLUDED.ip_address, devices.ip_address),
         last_seen = NOW()`,
      [deviceId, ipAddress]
    );
  }

  async saveVideo(
    deviceId: string,
    channel: number,
    filePath: string,
    startTime: Date,
    videoType: 'live' | 'alert_pre' | 'alert_post' | 'camera_sd' | 'manual',
    alertId?: string,
    frameCount?: number
  ) {
    if (!this.dbEnabled) {
      return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    await this.ensureDeviceExists(deviceId);

    const result = await query(
      `INSERT INTO videos (device_id, channel, file_path, start_time, video_type, alert_id, frame_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [deviceId, channel, filePath, startTime, videoType, alertId || null, Math.max(0, Number(frameCount || 0))]
    );
    return result.rows[0].id;
  }

  async updateVideoProgress(id: string, endTime: Date, fileSize: number, duration: number, frameCount?: number) {
    if (!this.dbEnabled) return;
    await query(
      `UPDATE videos
       SET end_time = $1,
           file_size = GREATEST(COALESCE(file_size, 0), $2),
           duration_seconds = GREATEST(COALESCE(duration_seconds, 0), $3),
           frame_count = GREATEST(COALESCE(frame_count, 0), $4)
       WHERE id = $5`,
      [endTime, fileSize, duration, Math.max(0, Number(frameCount || 0)), id]
    );
  }

  async updateVideoEnd(id: string, endTime: Date, fileSize: number, duration: number, frameCount?: number) {
    await this.updateVideoProgress(id, endTime, fileSize, duration, frameCount);
  }

  async uploadVideoToSupabase(id: string, localPath: string, deviceId: string, channel: number): Promise<string> {
    if (!hasSupabaseStorage()) {
      return localPath;
    }

    const bucketName = await this.bucketReady;
    const supabase = getSupabase();

    const stats = fs.statSync(localPath);
    const maxSize = 150 * 1024 * 1024;

    if (stats.size > maxSize) {
      console.warn(`Video too large for Supabase: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max 150MB). Skipping upload.`);
      console.log(`Video stored locally only: ${localPath}`);
      return localPath;
    }

    const videoData = fs.readFileSync(localPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = (localPath.split('.').pop() || 'mp4').toLowerCase();
    const filename = `${deviceId}/ch${channel}/${timestamp}.${ext}`;
    const contentType = ext === 'mp4' ? 'video/mp4' : 'video/h264';

    const { error } = await supabase.storage
      .from(bucketName)
      .upload(filename, videoData, {
        contentType,
        upsert: false
      });

    if (error) {
      console.error('Supabase video upload failed:', error);
      console.log(`Video stored locally only: ${localPath}`);
      return localPath;
    }

    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filename);

    const storageUrl = urlData.publicUrl;

    if (this.dbEnabled) {
      await query(
        `UPDATE videos SET storage_url = $1 WHERE id = $2`,
        [storageUrl, id]
      );
    }

    const deleteLocalAfterUpload = String(process.env.DELETE_LOCAL_VIDEO_AFTER_UPLOAD ?? 'true').toLowerCase() !== 'false';
    if (deleteLocalAfterUpload) {
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
        }
      } catch (err: any) {
        console.error(`Failed to delete local uploaded video ${localPath}:`, err?.message || err);
      }
    }

    console.log(`Video uploaded to Supabase: ${storageUrl}`);
    return storageUrl;
  }

  async getVideos(deviceId: string, limit: number = 50) {
    if (!this.dbEnabled) return [];
    const result = await query(
      `SELECT * FROM videos WHERE device_id = $1 ORDER BY start_time DESC LIMIT $2`,
      [deviceId, limit]
    );
    return result.rows;
  }

  async getAlertVideos(alertId: string) {
    if (!this.dbEnabled) return [];
    const result = await query(
      `SELECT * FROM videos WHERE alert_id = $1 ORDER BY video_type`,
      [alertId]
    );
    return result.rows;
  }
}
