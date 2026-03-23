import { AlertPriority, ExternalAlertInput } from '../alerts/alertManager';
import { LocationAlert } from '../types/jtt';
import { exec } from 'child_process';

type ForwarderOptions = {
  alertWorkerUrl?: string;
  videoWorkerUrl?: string;
  listenerServerUrl?: string;
  authToken?: string;
  forwardTimeoutMs?: number;
  failureThreshold?: number;
  recoveryCooldownMs?: number;
  alertWorkerRecoveryCommand?: string;
  videoWorkerRecoveryCommand?: string;
  listenerServerRecoveryCommand?: string;
};

type ForwardTarget = 'alertWorker' | 'videoWorker' | 'listenerServer';

type FailureState = {
  count: number;
  lastError?: string;
  lastFailureAt?: number;
  lastRecoveryAt?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WorkerForwarder {
  private readonly alertWorkerUrl?: string;
  private readonly videoWorkerUrl?: string;
  private readonly listenerServerUrl?: string;
  private readonly authToken?: string;
  private readonly forwardTimeoutMs: number;
  private readonly forwardRetryCount: number;
  private readonly failureThreshold: number;
  private readonly recoveryCooldownMs: number;
  private readonly recoveryCommands: Partial<Record<ForwardTarget, string>>;
  private readonly failureState = new Map<ForwardTarget, FailureState>();

  constructor(options: ForwarderOptions) {
    this.alertWorkerUrl = this.normalizeBaseUrl(options.alertWorkerUrl);
    this.videoWorkerUrl = this.normalizeBaseUrl(options.videoWorkerUrl);
    this.listenerServerUrl = this.normalizeBaseUrl(options.listenerServerUrl);
    this.authToken = options.authToken?.trim() || undefined;
    this.forwardTimeoutMs = Math.max(1000, Number(options.forwardTimeoutMs || 15000));
    this.forwardRetryCount = Math.max(1, Number(process.env.FORWARD_RETRY_COUNT || 3));
    this.failureThreshold = Math.max(1, Number(options.failureThreshold || 5));
    this.recoveryCooldownMs = Math.max(10000, Number(options.recoveryCooldownMs || 300000));
    this.recoveryCommands = {
      alertWorker: options.alertWorkerRecoveryCommand?.trim() || undefined,
      videoWorker: options.videoWorkerRecoveryCommand?.trim() || undefined,
      listenerServer: options.listenerServerRecoveryCommand?.trim() || undefined
    };
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
    await this.postJson('alertWorker', `${this.alertWorkerUrl}/api/internal/ingest/location-alert`, {
      sourceMessageId,
      alert: this.serializeAlert(alert)
    });
  }

  async forwardExternalAlert(input: ExternalAlertInput): Promise<void> {
    if (!this.alertWorkerUrl) return;
    await this.postJson('alertWorker', `${this.alertWorkerUrl}/api/internal/ingest/external-alert`, {
      input: this.serializeExternalAlert(input)
    });
  }

  async forwardRtpPacket(packet: Buffer, vehicleId: string, transport: 'tcp' | 'udp'): Promise<void> {
    if (!this.videoWorkerUrl) return;
    await this.postJson('videoWorker', `${this.videoWorkerUrl}/api/internal/ingest/rtp`, {
      vehicleId,
      transport,
      packetBase64: packet.toString('base64')
    });
  }

  async requestScreenshot(vehicleId: string, channel: number, alertId?: string): Promise<void> {
    if (!this.listenerServerUrl) return;
    await this.postJson('listenerServer', `${this.listenerServerUrl}/api/internal/commands/request-screenshot`, {
      vehicleId,
      channel,
      alertId
    });
  }

  async requestCameraVideo(vehicleId: string, channel: number, startTime: Date, endTime: Date, alertId?: string): Promise<void> {
    if (!this.listenerServerUrl) return;
    await this.postJson('listenerServer', `${this.listenerServerUrl}/api/internal/commands/request-camera-video`, {
      vehicleId,
      channel,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      alertId
    });
  }

  getAlertWorkerUrl(): string | undefined {
    return this.alertWorkerUrl;
  }

  getVideoWorkerUrl(): string | undefined {
    return this.videoWorkerUrl;
  }

  getListenerServerUrl(): string | undefined {
    return this.listenerServerUrl;
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

  private async postJson(target: ForwardTarget, url: string, body: any): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connection': 'close'
    };
    if (this.authToken) {
      headers['X-Internal-Token'] = this.authToken;
    }

    let lastError: any = null;
    for (let attempt = 1; attempt <= this.forwardRetryCount; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.forwardTimeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Forward failed ${response.status}: ${text || response.statusText}`);
        }

        this.resetFailureState(target);
        return;
      } catch (error: any) {
        lastError = error;
        const canRetry = attempt < this.forwardRetryCount && this.isRetryableForwardError(error);
        if (!canRetry) {
          this.recordFailure(target, url, error);
          throw error;
        }
        console.warn(
          `[WorkerForwarder] ${target} request failed on attempt ${attempt}/${this.forwardRetryCount} for ${url}: ${error?.message || error}`
        );
        await sleep(250 * attempt);
      } finally {
        clearTimeout(timeout);
      }
    }

    this.recordFailure(target, url, lastError);
    throw lastError;
  }

  private isRetryableForwardError(error: any): boolean {
    const message = String(error?.message || '').toLowerCase();
    const causeCode = String(error?.cause?.code || '').toUpperCase();
    return (
      message.includes('fetch failed') ||
      message.includes('aborted') ||
      causeCode === 'ECONNRESET' ||
      causeCode === 'ETIMEDOUT' ||
      causeCode === 'UND_ERR_SOCKET' ||
      causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    );
  }

  private resetFailureState(target: ForwardTarget): void {
    if (this.failureState.has(target)) {
      this.failureState.delete(target);
    }
  }

  private recordFailure(target: ForwardTarget, url: string, error: any): void {
    const now = Date.now();
    const state = this.failureState.get(target) || { count: 0 };
    state.count += 1;
    state.lastFailureAt = now;
    state.lastError = error?.message || String(error);
    this.failureState.set(target, state);

    if (state.count < this.failureThreshold) return;

    const command = this.recoveryCommands[target];
    if (!command) {
      console.warn(
        `[WorkerForwarder] ${target} failed ${state.count} times for ${url} but no recovery command is configured.`
      );
      return;
    }

    if (state.lastRecoveryAt && (now - state.lastRecoveryAt) < this.recoveryCooldownMs) {
      return;
    }

    state.lastRecoveryAt = now;
    console.warn(
      `[WorkerForwarder] ${target} failed ${state.count} times. Running recovery command: ${command}`
    );

    exec(command, { timeout: 60000 }, (execError, stdout, stderr) => {
      if (execError) {
        console.error(`[WorkerForwarder] Recovery command failed for ${target}: ${execError.message}`);
        return;
      }
      if (stdout?.trim()) {
        console.log(`[WorkerForwarder] Recovery stdout for ${target}: ${stdout.trim()}`);
      }
      if (stderr?.trim()) {
        console.warn(`[WorkerForwarder] Recovery stderr for ${target}: ${stderr.trim()}`);
      }
    });
  }
}
