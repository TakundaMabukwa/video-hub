import * as fs from 'fs';
import * as path from 'path';
import { ImageStorage } from '../storage/imageStorage';

interface MultimediaFragment {
  id: number;
  vehicleId: string;
  fragments: Buffer[];
  timestamp: Date;
}

export class MultimediaParser {
  private static fragmentBuffers = new Map<string, MultimediaFragment>();
  private static imageStorage = new ImageStorage();
  private static lastInvalidHeaderLogAt = 0;
  private static readonly verboseMediaLogs = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.VERBOSE_MEDIA_LOGS ?? 'false').trim().toLowerCase()
  );

  private static findJpegStart(data: Buffer): number {
    for (let i = 0; i < data.length - 1; i++) {
      if (data[i] === 0xff && data[i + 1] === 0xd8) return i;
    }
    return -1;
  }

  private static findJpegEnd(data: Buffer, fromIndex: number = 0): number {
    for (let i = Math.max(0, fromIndex); i < data.length - 1; i++) {
      if (data[i] === 0xff && data[i + 1] === 0xd9) return i + 2;
    }
    return -1;
  }

  static parseMultimediaData(body: Buffer, vehicleId: string): { type: string; data: Buffer; filename: string; channel: number } | null {
    if (body.length < 8) return null;

    try {
      const multimediaId = body.readUInt32BE(0);
      const multimediaType = body.readUInt8(4); // 0=image, 1=audio, 2=video
      const multimediaFormat = body.readUInt8(5); // 0=JPEG
      const eventCode = body.readUInt8(6);
      const channelId = body.readUInt8(7);

      // Data starts at byte 8
      const payload = body.slice(8);

      // Only parse screenshot payloads (image/jpeg).
      // 0x0801 can include other media types which are not JPEG bytes.
      if (multimediaType !== 0 || multimediaFormat !== 0) {
        return null;
      }

      // Check size limit (300MB)
      const maxSize = 300 * 1024 * 1024;
      if (payload.length > maxSize) {
        console.warn(`Image too large: ${(payload.length / 1024 / 1024).toFixed(2)}MB, skipping`);
        return null;
      }

      const jpegStart = this.findJpegStart(payload);
      if (jpegStart >= 0) {
        const jpegEnd = this.findJpegEnd(payload, jpegStart);

        if (jpegEnd > jpegStart) {
          // Complete JPEG found in single packet.
          const jpegData = payload.slice(jpegStart, jpegEnd);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${vehicleId}_ch${channelId}_event${eventCode}_${timestamp}.jpg`;

          if (this.verboseMediaLogs) {
            console.log(`Complete JPEG: ${jpegData.length} bytes, channel ${channelId}, event ${eventCode}`);
          }
          return { type: 'jpeg', data: jpegData, filename, channel: channelId };
        }

        // Fragmented start found, buffer remaining bytes.
        const key = `${vehicleId}_${multimediaId}`;
        const existing = this.fragmentBuffers.get(key);
        const chunk = payload.slice(jpegStart);

        if (!existing) {
          this.fragmentBuffers.set(key, {
            id: multimediaId,
            vehicleId,
            fragments: [chunk],
            timestamp: new Date()
          });
          if (this.verboseMediaLogs) {
            console.log(`Fragment 1 buffered for ${key}`);
          }
        } else {
          existing.fragments.push(chunk);
          if (this.verboseMediaLogs) {
            console.log(`Fragment ${existing.fragments.length} buffered for ${key}`);
          }

          const combined = Buffer.concat(existing.fragments);
          const combinedStart = this.findJpegStart(combined);
          const combinedEnd = combinedStart >= 0 ? this.findJpegEnd(combined, combinedStart) : -1;

          if (combinedStart >= 0 && combinedEnd > combinedStart) {
            const jpegData = combined.slice(combinedStart, combinedEnd);
            this.fragmentBuffers.delete(key);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${vehicleId}_ch${channelId}_event${eventCode}_${timestamp}.jpg`;

            if (this.verboseMediaLogs) {
              console.log(`Complete JPEG from ${existing.fragments.length} fragments: ${jpegData.length} bytes`);
            }
            return { type: 'jpeg', data: jpegData, filename, channel: channelId };
          }
        }
      } else {
        // Throttle invalid payload warnings to avoid log flooding.
        const now = Date.now();
        if (this.verboseMediaLogs && now - this.lastInvalidHeaderLogAt > 5000) {
          this.lastInvalidHeaderLogAt = now;
          console.warn(`Invalid JPEG payload for 0x0801 image message: ${payload[0]?.toString(16)} ${payload[1]?.toString(16)}`);
        }
      }

      return null;
    } catch (error) {
      console.error('Error parsing multimedia data:', error);
      return null;
    }
  }

  static async saveMultimediaFile(vehicleId: string, filename: string, data: Buffer, channel: number = 1): Promise<string> {
    // Validate JPEG before saving
    if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) {
      throw new Error('Invalid JPEG: Missing start marker (FFD8)');
    }

    // Check for end marker
    let hasEnd = false;
    for (let i = data.length - 2; i >= Math.max(0, data.length - 100); i--) {
      if (data[i] === 0xff && data[i + 1] === 0xd9) {
        hasEnd = true;
        break;
      }
    }

    if (!hasEnd) {
      throw new Error('Invalid JPEG: Missing end marker (FFD9)');
    }

    const mediaDir = path.join(process.cwd(), 'media', vehicleId);

    if (!fs.existsSync(mediaDir)) {
      fs.mkdirSync(mediaDir, { recursive: true });
    }

    const filePath = path.join(mediaDir, filename);
    fs.writeFileSync(filePath, data);

    if (this.verboseMediaLogs) {
      console.log(`Saved valid JPEG: ${filePath} (${data.length} bytes)`);
    }

    // Save to database
    try {
      await this.imageStorage.saveImageFromPath(vehicleId, channel, filePath, data.length);
    } catch (error) {
      console.error('Failed to save image to database:', error);
    }

    return filePath;
  }

  // Cleanup old fragments (call periodically)
  static cleanupFragments(): void {
    const now = Date.now();
    for (const [key, frag] of this.fragmentBuffers.entries()) {
      if (now - frag.timestamp.getTime() > 30000) {
        this.fragmentBuffers.delete(key);
      }
    }
  }
}
