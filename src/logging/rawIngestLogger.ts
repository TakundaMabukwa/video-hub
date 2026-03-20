import * as fs from 'fs';
import * as path from 'path';

export class RawIngestLogger {
  private static readonly dirPath = path.join(process.cwd(), 'logs');
  private static readonly filePath = path.join(RawIngestLogger.dirPath, 'raw-ingest.ndjson');
  private static readonly maxHexChars = 16384;
  private static readonly enabled = RawIngestLogger.resolveEnabled();

  private static resolveEnabled(): boolean {
    const explicit = process.env.RAW_INGEST_LOGGING_ENABLED;
    if (typeof explicit === 'string' && explicit.trim()) {
      return ['1', 'true', 'yes', 'on'].includes(explicit.trim().toLowerCase());
    }

    const alertProcessing = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.ALERT_PROCESSING_ENABLED ?? 'true').trim().toLowerCase()
    );
    const videoProcessing = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.VIDEO_PROCESSING_ENABLED ?? 'true').trim().toLowerCase()
    );
    return alertProcessing || videoProcessing;
  }

  private static ensureReady(): void {
    if (!fs.existsSync(this.dirPath)) {
      fs.mkdirSync(this.dirPath, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', 'utf8');
    }
  }

  private static trimHex(hex: string): string {
    if (!hex) return '';
    if (hex.length <= this.maxHexChars) return hex;
    return `${hex.slice(0, this.maxHexChars)}...[truncated]`;
  }

  static write(eventType: string, payload: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      this.ensureReady();
      const safePayload: Record<string, unknown> = { ...payload };
      if (typeof safePayload.rawFrameHex === 'string') {
        safePayload.rawFrameHex = this.trimHex(safePayload.rawFrameHex);
      }
      if (typeof safePayload.bodyHex === 'string') {
        safePayload.bodyHex = this.trimHex(safePayload.bodyHex);
      }
      if (typeof safePayload.rawPayloadHex === 'string') {
        safePayload.rawPayloadHex = this.trimHex(safePayload.rawPayloadHex);
      }
      const row = {
        ts: new Date().toISOString(),
        eventType,
        ...safePayload
      };
      fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
      // Never throw from telemetry path.
    }
  }
}
