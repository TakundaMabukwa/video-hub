import { AlertManager, ExternalAlertInput } from './alertManager';
import { WorkerForwarder } from '../services/workerForwarder';
import { LocationAlert } from '../types/jtt';

export class ForwardingAlertManager extends AlertManager {
  constructor(private readonly forwarder: WorkerForwarder) {
    super();
  }

  override async processAlert(alert: LocationAlert): Promise<void> {
    await this.forwarder.forwardLocationAlert(
      alert,
      String((alert as any)?.sourceMessageId || '0x0200')
    );
  }

  override async processExternalAlert(input: ExternalAlertInput): Promise<void> {
    await this.forwarder.forwardExternalAlert(input);
  }

  override addFrameToBuffer(): void {
    // Listener mode does not retain frame buffers locally.
  }

  override getActiveAlerts() {
    return [];
  }

  override getAlertById() {
    return undefined;
  }
}
