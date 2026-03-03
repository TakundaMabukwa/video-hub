import * as fs from 'fs';
import * as path from 'path';
import { query } from './database';

export class ImageStorage {
  private readonly localRoot: string;

  constructor() {
    this.localRoot = path.join(process.cwd(), 'media', 'images');
    try {
      fs.mkdirSync(this.localRoot, { recursive: true });
    } catch {}
  }

  private buildLocalPath(relativeFilePath: string): string {
    return path.join(this.localRoot, relativeFilePath);
  }

  async saveImage(deviceId: string, channel: number, imageData: Buffer, alertId?: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const relativeFilePath = `${deviceId}/ch${channel}/${timestamp}.jpg`;
    const localPath = this.buildLocalPath(relativeFilePath);

    // Always persist a local copy for reliable fallback serving.
    try {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, imageData);
    } catch (err: any) {
      console.error(`Failed to persist local screenshot ${localPath}:`, err?.message || err);
    }

    // Screenshots are intentionally not uploaded to Supabase.
    // Persist local path + API-served URL only.
    const result = await query(
      `INSERT INTO images (device_id, channel, file_path, storage_url, file_size, timestamp, alert_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [deviceId, channel, relativeFilePath, '', imageData.length, new Date(), alertId || null]
    );

    const id = result.rows[0].id;
    await query(`UPDATE images SET storage_url = $1 WHERE id = $2`, [`/api/images/${id}/file`, id]);
    return id;
  }

  async saveImageFromPath(deviceId: string, channel: number, localPath: string, fileSize: number, alertId?: string): Promise<string> {
    const imageData = fs.readFileSync(localPath);
    return this.saveImage(deviceId, channel, imageData, alertId);
  }

  async getImages(deviceId: string, limit: number = 50) {
    const result = await query(
      `SELECT id, device_id, channel, storage_url, file_size, timestamp
       FROM images
       WHERE device_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [deviceId, limit]
    );
    return result.rows;
  }

  async getAlertImages(alertId: string) {
    const result = await query(
      `SELECT id, device_id, channel, storage_url, file_size, timestamp
       FROM images
       WHERE alert_id = $1
       ORDER BY timestamp DESC`,
      [alertId]
    );
    return result.rows;
  }
}
