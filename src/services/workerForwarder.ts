import { AlertPriority, ExternalAlertInput } from '../alerts/alertManager';
import { LocationAlert } from '../types/jtt';

type ForwarderOptions = {
  alertWorkerUrl?: string;
  videoWorkerUrl?: string;
  listenerServerUrl?: string;
  authToken?: string;
};

export class WorkerForwarder {
  private readonly alertWorkerUrl?: string;
  private readonly videoWorkerUrl?: string;
  private readonly listenerServerUrl?: string;
  private readonly authToken?: string;

  constructor(options: ForwarderOptions) {
    this.alertWorkerUrl = this.normalizeBaseUrl(options.alertWorkerUrl);
    this.videoWorkerUrl = this.normalizeBaseUrl(options.videoWorkerUrl);
    this.listenerServerUrl = this.normalizeBaseUrl(options.listenerServerUrl);
    this.authToken = options.authToken?.trim() || undefined;
  }

  hasAlertWorker(): boolean {
    return !!this.alertWorkerUrl;
  }

  hasVideoWorker(): boolean {
    return !!this.videoWorkerUrl;
  }

  hasListenerServer(): boolean {
    return !!this.listenerServerUrl;
  }

  async forwardLocationAlert(alert: LocationAlert, sourceMessageId: string): Promise<void> {
    if (!this.alertWorkerUrl) return;
    await this.postJson(`${this.alertWorkerUrl}/api/internal/ingest/location-alert`, {
      sourceMessageId,
      alert: this.serializeAlert(alert)
    });
  }

  async forwardExternalAlert(input: ExternalAlertInput): Promise<void> {
    if (!this.alertWorkerUrl) return;
    await this.postJson(`${this.alertWorkerUrl}/api/internal/ingest/external-alert`, {
      input: this.serializeExternalAlert(input)
    });
  }

  async forwardRtpPacket(packet: Buffer, vehicleId: string, transport: 'tcp' | 'udp'): Promise<void> {
    if (!this.videoWorkerUrl) return;
    await this.postJson(`${this.videoWorkerUrl}/api/internal/ingest/rtp`, {
      vehicleId,
      transport,
      packetBase64: packet.toString('base64')
    });
  }

  async requestScreenshot(vehicleId: string, channel: number, alertId?: string): Promise<void> {
    if (!this.listenerServerUrl) return;
    await this.postJson(`${this.listenerServerUrl}/api/internal/commands/request-screenshot`, {
      vehicleId,
      channel,
      alertId
    });
  }

  async requestCameraVideo(vehicleId: string, channel: number, startTime: Date, endTime: Date, alertId?: string): Promise<void> {
    if (!this.listenerServerUrl) return;
    await this.postJson(`${this.listenerServerUrl}/api/internal/commands/request-camera-video`, {
      vehicleId,
      channel,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      alertId
    });
  }

  private serializeAlert(alert: LocationAlert): any {
    return {
      ...alert,
      timestamp: alert.timestamp instanceof Date ? alert.timestamp.toISOString() : alert.timestamp
    };
  }

  private serializeExternalAlert(input: ExternalAlertInput): any {
    return {
      ...input,
      timestamp: input.timestamp instanceof Date ? input.timestamp.toISOString() : input.timestamp,
      priority: input.priority ? String(input.priority) as AlertPriority : undefined
    };
  }

  private normalizeBaseUrl(url?: string): string | undefined {
    const normalized = String(url || '').trim().replace(/\/+$/, '');
    return normalized || undefined;
  }

  private async postJson(url: string, body: any): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.authToken) {
      headers['X-Internal-Token'] = this.authToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Forward failed ${response.status}: ${text || response.statusText}`);
    }
  }
}
