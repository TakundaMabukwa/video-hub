import { EventEmitter } from 'events';
import { LocationAlert } from '../types/jtt';
import { CircularVideoBuffer } from './circularBuffer';
import { AlertEscalation } from './escalation';
import { AlertNotifier } from './notifier';
import { AlertStorageDB } from '../storage/alertStorageDB';
import { VideoStorage } from '../storage/videoStorage';
import { getVendorAlarmBySignalCode } from '../protocol/vendorAlarmCatalog';
import * as fs from 'fs';

export enum AlertPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',

  CRITICAL = 'critical'
}

export interface AlertEvent {
  id: string;
  vehicleId: string;
  channel: number;
  priority: AlertPriority;
  type: string;
  timestamp: Date;
  location: { latitude: number; longitude: number };
  videoClipPath?: string;  // Legacy: pre-event clip path
  status: 'new' | 'acknowledged' | 'escalated' | 'resolved';
  escalationLevel: number;
  metadata: any & {
    videoClips?: {
      pre?: string;      // Pre-event (30s before) clip path
      post?: string;     // Post-event (30s after) clip path
      preFrameCount?: number;
      postFrameCount?: number;
      preDuration?: number;
      postDuration?: number;
      cameraVideo?: string;  // Video retrieved from camera SD card
      preVideoId?: string;
      postVideoId?: string;
      preStorageUrl?: string;
      postStorageUrl?: string;
    };
  };
}

export interface ExternalAlertInput {
  vehicleId: string;
  type: string;
  signalCode?: string;
  channel?: number;
  timestamp?: Date;
  priority?: AlertPriority;
  location?: { latitude: number; longitude: number };
  metadata?: Record<string, any>;
  signatureScope?: string;
}

export class AlertManager extends EventEmitter {
  private videoBuffers = new Map<string, CircularVideoBuffer>();
  private activeAlerts = new Map<string, AlertEvent>();
  private signalStateByVehicleChannel = new Map<string, Set<string>>();
  private recentAlertSignatures = new Map<string, number>();
  private noisyLogGate = new Map<string, number>();
  private escalation: AlertEscalation;
  private notifier: AlertNotifier;
  private alertStorage = new AlertStorageDB();
  private videoStorage = new VideoStorage();
  private alertCounter = 0;
  private readonly duplicateWindowMs = Math.max(0, Number(process.env.ALERT_DEDUP_WINDOW_MS || 30000));

  private buildEvidenceSummary(metadata: any): any {
    const evidence = metadata?.evidence || {};
    const screenshots = Array.isArray(evidence?.screenshots) ? evidence.screenshots : [];
    const videos = Array.isArray(evidence?.videos) ? evidence.videos : [];
    return {
      screenshots,
      videos,
      screenshotCount: screenshots.length,
      videoCount: videos.length,
      lastUpdatedAt: new Date().toISOString()
    };
  }

  private async patchAlertMetadata(
    alertId: string,
    patcher: (metadata: Record<string, any>) => Record<string, any>
  ): Promise<void> {
    const active = this.activeAlerts.get(alertId);
    if (active) {
      const next = patcher(active.metadata || {});
      active.metadata = next;
      await this.alertStorage.saveAlert(active);
      return;
    }

    const row = await this.alertStorage.getAlertById(alertId);
    if (!row) return;
    const current = typeof row.metadata === 'string'
      ? (() => { try { return JSON.parse(row.metadata || '{}'); } catch { return {}; } })()
      : (row.metadata || {});
    const next = patcher(current);
    await this.alertStorage.updateAlertMetadata(alertId, next);
  }

  async registerAlertScreenshotEvidence(input: {
    alertId: string;
    imageId: string;
    channel: number;
    source: string;
    storageUrl?: string | null;
  }): Promise<void> {
    if (!input.alertId || !input.imageId) return;
    await this.patchAlertMetadata(input.alertId, (metadata) => {
      const next = { ...(metadata || {}) };
      next.evidence = next.evidence || {};
      const screenshots = Array.isArray(next.evidence.screenshots) ? [...next.evidence.screenshots] : [];
      const key = String(input.imageId);
      if (!screenshots.some((s: any) => String(s?.imageId || '') === key)) {
        screenshots.push({
          imageId: input.imageId,
          channel: input.channel,
          source: input.source,
          storageUrl: input.storageUrl || null,
          capturedAt: new Date().toISOString()
        });
      }
      next.evidence.screenshots = screenshots;
      next.evidence = this.buildEvidenceSummary(next);
      return next;
    });
  }

  async registerAlertVideoEvidence(input: {
    alertId: string;
    channel: number;
    filePath: string;
    source: string;
    durationSec?: number;
  }): Promise<void> {
    const { alertId, channel, filePath, source } = input;
    if (!alertId || !filePath) return;
    if (!fs.existsSync(filePath)) return;

    const row = await this.alertStorage.getAlertById(alertId);
    if (!row) return;

    const deviceId = String(row.device_id || '');
    const alertTs = new Date(row.timestamp || Date.now());
    const duration = Math.max(1, Math.round(Number(input.durationSec || 8)));
    const startTime = new Date(alertTs.getTime());
    const endTime = new Date(startTime.getTime() + duration * 1000);
    const stats = fs.statSync(filePath);

    const videoId = await this.videoStorage.saveVideo(
      deviceId,
      Number(channel || row.channel || 1),
      filePath,
      startTime,
      'camera_sd',
      alertId
    );
    await this.videoStorage.updateVideoEnd(videoId, endTime, stats.size, duration);

    let storageUrl = filePath;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      storageUrl = await this.videoStorage.uploadVideoToSupabase(
        videoId,
        filePath,
        deviceId,
        Number(channel || row.channel || 1)
      );
    }

    await this.patchAlertMetadata(alertId, (metadata) => {
      const next = { ...(metadata || {}) };
      next.videoClips = next.videoClips || {};
      next.videoClips.cameraVideoLocalPath = filePath;
      next.videoClips.cameraVideoVideoId = String(videoId);
      next.videoClips.cameraVideo = storageUrl || filePath;
      next.videoClips.cameraVideoSource = source;
      next.videoClips.cameraVideoDuration = duration;

      next.evidence = next.evidence || {};
      const videos = Array.isArray(next.evidence.videos) ? [...next.evidence.videos] : [];
      const key = String(videoId);
      if (!videos.some((v: any) => String(v?.videoId || '') === key)) {
        videos.push({
          videoId: String(videoId),
          channel: Number(channel || row.channel || 1),
          source,
          durationSec: duration,
          storageUrl: storageUrl || null,
          localPath: filePath,
          capturedAt: new Date().toISOString()
        });
      }
      next.evidence.videos = videos;
      next.evidence = this.buildEvidenceSummary(next);
      return next;
    });
  }

  constructor() {
    super();
    this.escalation = new AlertEscalation(this);
    this.notifier = new AlertNotifier();

    // Forward notifier events
    this.notifier.on('notification', (notification) => {
      this.emit('notification', notification);
    });

    // Handle flooding events
    this.on('flooding', ({ vehicleId, count }) => {
      this.notifier.sendFloodingAlert(vehicleId, count);
    });
  }

  initializeBuffer(vehicleId: string, channel: number): void {
    const key = `${vehicleId}_${channel}`;
    if (!this.videoBuffers.has(key)) {
      const buffer = new CircularVideoBuffer(vehicleId, channel, 30);
      
      // Listen for post-event clip completion
      buffer.on('post-event-complete', async ({ alertId, clipPath, frameCount, duration }) => {
        const alert = this.activeAlerts.get(alertId);
        if (alert) {
          // Update alert with post-event video path
          if (!alert.metadata.videoClips) {
            alert.metadata.videoClips = {};
          }
          alert.metadata.videoClips.post = clipPath;
          alert.metadata.videoClips.postFrameCount = frameCount;
          alert.metadata.videoClips.postDuration = duration;
          await this.persistAlertClipVideo(alert, clipPath, 'alert_post', duration);
          
          console.log(`✅ Alert ${alertId}: Post-event video linked (${frameCount} frames, ${duration.toFixed(1)}s)`);
          
          // Update in database
          await this.alertStorage.saveAlert(alert);
          
          // Emit event for any listeners
          this.emit('alert-video-complete', { alertId, type: 'post', clipPath });
        }
      });
      
      this.videoBuffers.set(key, buffer);
      console.log(`📹 Circular buffer initialized: ${key}`);
    }
  }

  addFrameToBuffer(vehicleId: string, channel: number, frameData: Buffer, timestamp: Date, isIFrame: boolean): void {
    const key = `${vehicleId}_${channel}`;
    
    // Auto-initialize buffer if it doesn't exist (ensures we capture video even before startVideo is called)
    if (!this.videoBuffers.has(key)) {
      this.initializeBuffer(vehicleId, channel);
    }
    
    const buffer = this.videoBuffers.get(key);
    if (buffer) {
      buffer.addFrame(frameData, timestamp, isIFrame);
    }
  }

  async processAlert(alert: LocationAlert): Promise<void> {
    const allAlertSignals = this.extractAlertSignals(alert);
    const alertSignals = this.filterActionableSignals(allAlertSignals);
    const channel = this.extractChannelFromAlert(alert);
    const stateKey = `${alert.vehicleId}|${channel}`;
    if (alertSignals.length === 0) {
      // Clear edge-trigger state once terminal reports no active alerts for this key.
      // Without this, subsequent re-occurrence of the same alert is never emitted.
      this.signalStateByVehicleChannel.delete(stateKey);
      return;
    }

    const previousSignals = this.signalStateByVehicleChannel.get(stateKey) || new Set<string>();
    const currentSignals = new Set(alertSignals);
    const newlyRaisedSignals = alertSignals.filter((s) => !previousSignals.has(s));

    if (currentSignals.size > 0) {
      this.signalStateByVehicleChannel.set(stateKey, currentSignals);
    } else {
      this.signalStateByVehicleChannel.delete(stateKey);
    }

    // Edge-triggered behavior: only create an alert when a new signal appears.
    if (newlyRaisedSignals.length === 0) return;

    for (const signalCode of newlyRaisedSignals) {
      const alertSignalDetail = this.getSignalDetail(signalCode);
      const primaryType = this.getPrimaryAlertTypeForSignal(alert, signalCode, alertSignalDetail.label);
      const signature = this.buildAlertSignature(
        alert.vehicleId,
        channel,
        signalCode,
        String((alert as any)?.sourceMessageId || '0x0200')
      );

      if (this.shouldSuppressDuplicate(signature, alert.timestamp)) {
        continue;
      }

      const priority = this.determinePriorityForSignal(alert, signalCode);
      const alertId = `ALT-${Date.now()}-${++this.alertCounter}`;

      const alertEvent: AlertEvent = {
        id: alertId,
        vehicleId: alert.vehicleId,
        channel,
        priority,
        type: primaryType,
        timestamp: alert.timestamp,
        location: { latitude: alert.latitude, longitude: alert.longitude },
        status: 'new',
        escalationLevel: 0,
        metadata: {
          ...alert,
          alertSignals: [signalCode],
          activeSignalsSnapshot: alertSignals,
          rawAlertSignals: allAlertSignals,
          alertLabels: [alertSignalDetail.label],
          alertSignalDetails: [alertSignalDetail],
          primaryAlertType: primaryType
        }
      };

      this.activeAlerts.set(alertId, alertEvent);
      await this.alertStorage.saveAlert(alertEvent);

      console.log(`📸 Requesting screenshot for alert ${alertId}`);
      this.emit('request-screenshot', { vehicleId: alert.vehicleId, channel, alertId });

      await Promise.allSettled([
        this.captureEventVideo(alertEvent),
        this.requestAlertVideoFromCamera(alertEvent)
      ]);

      this.notifier.sendAlertNotification(alertEvent);
      this.escalation.monitorAlert(alertEvent);
      this.emit('alert', alertEvent);

      console.log(`🚨 Alert ${alertId}: ${alertEvent.type} [${priority}]`);
    }
  }

  async processExternalAlert(input: ExternalAlertInput): Promise<void> {
    const timestamp = input.timestamp || new Date();
    const channel = input.channel || 1;
    const baseSignalCode =
      input.signalCode ||
      `external_${String(input.type || 'alert')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')}`;
    const filtered = this.filterActionableSignals([baseSignalCode]);
    if (filtered.length === 0) return;
    const signalCode = filtered[0];
    const signature = this.buildAlertSignature(
      input.vehicleId,
      channel,
      signalCode,
      input.signatureScope || input.metadata?.alertSignatureScope || input.metadata?.sourceMessageId || 'external'
    );

    if (this.shouldSuppressDuplicate(signature, timestamp)) {
      return;
    }

    const priority = input.priority || AlertPriority.MEDIUM;
    const alertId = `ALT-${Date.now()}-${++this.alertCounter}`;
    const location = input.location || { latitude: 0, longitude: 0 };
    const alertSignalDetails = [this.getSignalDetail(signalCode)];

    const alertEvent: AlertEvent = {
      id: alertId,
      vehicleId: input.vehicleId,
      channel,
      priority,
      type: input.type || alertSignalDetails[0].label || 'External Alert',
      timestamp,
      location,
      status: 'new',
      escalationLevel: 0,
      metadata: {
        source: 'external',
        alertSignals: [signalCode],
        alertLabels: [alertSignalDetails[0].label],
        alertSignalDetails,
        ...input.metadata
      }
    };

    this.activeAlerts.set(alertId, alertEvent);
    await this.alertStorage.saveAlert(alertEvent);

    // Keep evidence workflow consistent across alert sources.
    this.emit('request-screenshot', { vehicleId: input.vehicleId, channel, alertId });
    await Promise.allSettled([
      this.captureEventVideo(alertEvent),
      this.requestAlertVideoFromCamera(alertEvent)
    ]);

    this.notifier.sendAlertNotification(alertEvent);
    this.escalation.monitorAlert(alertEvent);
    this.emit('alert', alertEvent);

    console.log(`External alert ${alertId}: ${alertEvent.type} [${priority}]`);
  }

  private buildAlertSignature(
    vehicleId: string,
    channel: number,
    primaryType: string,
    scope?: string
  ): string {
    const normalizedScope = String(scope || 'default').toLowerCase().trim();
    return `${vehicleId}|${channel}|${normalizedScope}|${primaryType.toLowerCase().trim()}`;
  }

  private shouldSuppressDuplicate(signature: string, now: Date): boolean {
    if (this.duplicateWindowMs <= 0) {
      return false;
    }

    const nowMs = now.getTime();
    const lastSeenMs = this.recentAlertSignatures.get(signature);

    if (lastSeenMs !== undefined && nowMs - lastSeenMs < this.duplicateWindowMs) {
      return true;
    }

    this.recentAlertSignatures.set(signature, nowMs);

    for (const [key, ts] of this.recentAlertSignatures.entries()) {
      if (nowMs - ts >= this.duplicateWindowMs) {
        this.recentAlertSignatures.delete(key);
      }
    }

    return false;
  }

  private shouldLogNoisy(key: string, throttleMs: number = 10000): boolean {
    const now = Date.now();
    const last = this.noisyLogGate.get(key) || 0;
    if (now - last < throttleMs) return false;
    this.noisyLogGate.set(key, now);
    return true;
  }

  private async captureEventVideo(alert: AlertEvent): Promise<void> {
    const key = `${alert.vehicleId}_${alert.channel}`;
    const buffer = this.videoBuffers.get(key);

    if (!buffer) {
      console.warn(`⚠️ No buffer for ${key}, cannot capture pre-event video`);
      return;
    }
    
    // Check buffer has enough data
    const stats = buffer.getStats();
    if (stats.totalFrames === 0) {
      if (this.shouldLogNoisy(`buffer_empty:${key}`, 15000)) {
        console.warn(`Buffer ${key} is empty - cannot capture pre-event clip yet`);
      }
      return;
    }

    const preClip = await buffer.captureEventClip(alert.id, 30);
    
    // Only store path if we got a valid clip
    if (preClip?.clipPath) {
      if (!alert.metadata.videoClips) {
        alert.metadata.videoClips = {};
      }
      alert.metadata.videoClips.pre = preClip.clipPath;
      alert.metadata.videoClips.preFrameCount = preClip.frameCount;
      alert.metadata.videoClips.preDuration = preClip.duration;
      alert.videoClipPath = preClip.clipPath;
      await this.persistAlertClipVideo(alert, preClip.clipPath, 'alert_pre', Math.max(1, Math.round(preClip.duration)));
      
      await this.alertStorage.saveAlert(alert);
      console.log(`✅ Alert ${alert.id}: Pre-event video captured, post-event recording started (30s)`);
    } else {
      console.warn(`⚠️ Alert ${alert.id}: No pre-event video available (buffer empty)`);
    }
  }

  private determinePriority(alert: LocationAlert, alertSignals: string[]): AlertPriority {
    // CRITICAL: emergency, collision/rollover warning, or severe fatigue
    if (alert.alarmFlags?.emergency ||
        alert.alarmFlags?.collisionWarning ||
        alert.alarmFlags?.rolloverWarning ||
        (alert.drivingBehavior?.fatigueLevel !== undefined && alert.drivingBehavior.fatigueLevel > 80)) {
      return AlertPriority.CRITICAL;
    }

    // HIGH: clear unsafe driving signals and storage failures
    if (alert.alarmFlags?.fatigue ||
        alert.alarmFlags?.dangerousDriving ||
        alert.alarmFlags?.fatigueWarning ||
        alert.drivingBehavior?.fatigue ||
        alert.drivingBehavior?.phoneCall || 
        alert.drivingBehavior?.smoking ||
        alert.videoAlarms?.storageFailure) {
      return AlertPriority.HIGH;
    }

    // MEDIUM: video signal quality/system issues and speed alarms
    if (alert.videoAlarms?.videoSignalLoss ||
        alert.videoAlarms?.videoSignalBlocking ||
        alert.videoAlarms?.busOvercrowding ||
        alert.alarmFlags?.overspeed ||
        alert.alarmFlags?.overspeedWarning) {
      return AlertPriority.MEDIUM;
    }

    // Any remaining active signal should still be stored as at least LOW.
    if (alertSignals.length > 0) return AlertPriority.LOW;
    return AlertPriority.LOW;
  }

  private determinePriorityForSignal(alert: LocationAlert, signalCode: string): AlertPriority {
    if (signalCode.startsWith('adas_')) return this.lookupCatalogPriority(signalCode) || AlertPriority.HIGH;
    if (signalCode.startsWith('dms_')) return this.lookupCatalogPriority(signalCode) || AlertPriority.HIGH;
    if (signalCode.startsWith('behavior_')) return this.lookupCatalogPriority(signalCode) || AlertPriority.MEDIUM;

    if (signalCode === 'jt808_emergency' || signalCode === 'jt808_collision_warning' || signalCode === 'jt808_rollover_warning') {
      return AlertPriority.CRITICAL;
    }

    if (
      signalCode === 'jt808_fatigue' ||
      signalCode === 'jt808_dangerous_driving' ||
      signalCode === 'jt808_fatigue_warning' ||
      signalCode === 'jtt1078_behavior_fatigue' ||
      signalCode === 'jtt1078_behavior_phone_call' ||
      signalCode === 'jtt1078_behavior_smoking' ||
      signalCode === 'jtt1078_storage_failure' ||
      signalCode === 'jtt1078_abnormal_driving' ||
      signalCode === 'platform_video_alarm_0103' ||
      signalCode === 'platform_video_alarm_0106'
    ) {
      return AlertPriority.HIGH;
    }

    if (
      signalCode === 'jt808_overspeed' ||
      signalCode === 'jt808_overspeed_warning' ||
      signalCode === 'jtt1078_video_signal_loss' ||
      signalCode === 'jtt1078_video_signal_blocking' ||
      signalCode === 'jtt1078_bus_overcrowding' ||
      signalCode === 'jtt1078_other_video_failure' ||
      signalCode === 'jtt1078_memory_failure' ||
      signalCode === 'platform_video_alarm_0101' ||
      signalCode === 'platform_video_alarm_0102' ||
      signalCode === 'platform_video_alarm_0104' ||
      signalCode === 'platform_video_alarm_0105' ||
      signalCode === 'platform_video_alarm_0107'
    ) {
      return AlertPriority.MEDIUM;
    }

    return this.determinePriority(alert, [signalCode]);
  }

  private async persistAlertClipVideo(
    alert: AlertEvent,
    clipPath: string,
    videoType: 'alert_pre' | 'alert_post',
    durationSec: number
  ): Promise<void> {
    try {
      const startTime = videoType === 'alert_pre'
        ? new Date(alert.timestamp.getTime() - 30 * 1000)
        : new Date(alert.timestamp.getTime());
      const endTime = new Date(startTime.getTime() + Math.max(1, Math.round(durationSec)) * 1000);
      const stats = require('fs').statSync(clipPath);

      const videoId = await this.videoStorage.saveVideo(
        alert.vehicleId,
        alert.channel,
        clipPath,
        startTime,
        videoType,
        alert.id
      );
      await this.videoStorage.updateVideoEnd(videoId, endTime, stats.size, Math.max(1, Math.round(durationSec)));

      let publicUrl: string | null = null;
      const isArchiveOnlyClip = /\.farc$/i.test(clipPath);
      if (!isArchiveOnlyClip && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        publicUrl = await this.videoStorage.uploadVideoToSupabase(
          videoId,
          clipPath,
          alert.vehicleId,
          alert.channel
        );
      }

      if (!alert.metadata.videoClips) {
        alert.metadata.videoClips = {};
      }
      const safeFallback = videoType === 'alert_pre'
        ? `/api/alerts/${encodeURIComponent(alert.id)}/video/pre`
        : `/api/alerts/${encodeURIComponent(alert.id)}/video/post`;
      const publicHttpUrl = publicUrl && /^https?:\/\//i.test(publicUrl)
        ? publicUrl
        : safeFallback;
      if (videoType === 'alert_pre') {
        alert.metadata.videoClips.preVideoId = String(videoId);
        alert.metadata.videoClips.preStorageUrl = publicHttpUrl;
      } else {
        alert.metadata.videoClips.postVideoId = String(videoId);
        alert.metadata.videoClips.postStorageUrl = publicHttpUrl;
      }
    } catch (error: any) {
      console.warn(`⚠️ Failed to persist ${videoType} for alert ${alert.id}: ${error?.message || error}`);
    }
  }

  private getPrimaryAlertType(alert: LocationAlert, alertSignals: string[]): string {
    if (alert.alarmFlags?.emergency) return 'Emergency Alarm';
    if (alert.alarmFlags?.collisionWarning) return 'Collision Warning';
    if (alert.alarmFlags?.rolloverWarning) return 'Rollover Warning';
    if (alert.drivingBehavior?.fatigue || alert.alarmFlags?.fatigue) return 'Driver Fatigue';
    if (alert.drivingBehavior?.phoneCall || alert.alarmFlags?.dangerousDriving) return 'Dangerous Driving Behavior';
    if (alert.drivingBehavior?.smoking) return 'Smoking While Driving';
    if (alert.alarmFlags?.overspeed || alert.alarmFlags?.overspeedWarning) return 'Overspeed Alarm';
    if (alert.videoAlarms?.storageFailure) return 'Storage Failure';
    if (alert.videoAlarms?.videoSignalLoss) return 'Video Signal Loss';
    if (alert.videoAlarms?.videoSignalBlocking) return 'Video Signal Blocked';
    if (alert.videoAlarms?.busOvercrowding) return 'Bus Overcrowding';
    if (alertSignals.length > 0) return this.getSignalDetail(alertSignals[0]).label;
    return 'General Alert';
  }

  private getPrimaryAlertTypeForSignal(alert: LocationAlert, signalCode: string, fallbackLabel?: string): string {
    if (signalCode === 'jt808_emergency') return 'Emergency Alarm';
    if (signalCode === 'jt808_collision_warning') return 'Collision Warning';
    if (signalCode === 'jt808_rollover_warning') return 'Rollover Warning';
    if (signalCode === 'jt808_fatigue' || signalCode === 'jtt1078_behavior_fatigue') return 'Driver Fatigue';
    if (signalCode === 'jt808_dangerous_driving' || signalCode === 'jtt1078_behavior_phone_call') return 'Dangerous Driving Behavior';
    if (signalCode === 'jtt1078_behavior_smoking') return 'Smoking While Driving';
    if (signalCode === 'jt808_overspeed' || signalCode === 'jt808_overspeed_warning') return 'Overspeed Alarm';
    if (signalCode === 'jtt1078_storage_failure' || signalCode === 'platform_video_alarm_0103') return 'Storage Failure';
    if (signalCode === 'jtt1078_video_signal_loss' || signalCode === 'platform_video_alarm_0101') return 'Video Signal Loss';
    if (signalCode === 'jtt1078_video_signal_blocking' || signalCode === 'platform_video_alarm_0102') return 'Video Signal Blocked';
    if (signalCode === 'jtt1078_bus_overcrowding' || signalCode === 'platform_video_alarm_0105') return 'Bus Overcrowding';
    if (signalCode === 'jtt1078_other_video_failure' || signalCode === 'platform_video_alarm_0104') return 'Other Video Equipment Failure';
    if (signalCode === 'jtt1078_abnormal_driving' || signalCode === 'platform_video_alarm_0106') return 'Abnormal Driving Behavior';
    if (signalCode === 'jtt1078_special_alarm_threshold' || signalCode === 'platform_video_alarm_0107') return 'Special Alarm Recording Threshold';
    if (signalCode.startsWith('adas_') || signalCode.startsWith('dms_') || signalCode.startsWith('behavior_')) {
      return this.getSignalDetail(signalCode).label;
    }
    return fallbackLabel || this.getPrimaryAlertType(alert, [signalCode]);
  }

  private lookupCatalogPriority(signalCode: string): AlertPriority | null {
    const mapped = getVendorAlarmBySignalCode(signalCode);
    if (!mapped) return null;
    if (mapped.defaultPriority === 'critical') return AlertPriority.CRITICAL;
    if (mapped.defaultPriority === 'high') return AlertPriority.HIGH;
    if (mapped.defaultPriority === 'medium') return AlertPriority.MEDIUM;
    return AlertPriority.LOW;
  }

  private extractChannelFromAlert(alert: LocationAlert): number {
    if (alert.signalLossChannels && alert.signalLossChannels.length > 0) {
      return alert.signalLossChannels[0];
    }
    if (alert.blockingChannels && alert.blockingChannels.length > 0) {
      return alert.blockingChannels[0];
    }
    return 1;
  }

  getActiveAlerts(): AlertEvent[] {
    return Array.from(this.activeAlerts.values())
      .filter(a => a.status !== 'resolved')
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  getAlertById(id: string): AlertEvent | undefined {
    return this.activeAlerts.get(id);
  }

  async acknowledgeAlert(id: string): Promise<boolean> {
    const alert = this.activeAlerts.get(id);
    if (alert && alert.status === 'new') {
      alert.status = 'acknowledged';
      await this.alertStorage.updateAlertStatus(id, 'acknowledged', new Date());
      this.emit('alert-acknowledged', alert);
      return true;
    }
    return false;
  }

  async resolveAlert(id: string, notes?: string, resolvedBy?: string): Promise<boolean> {
    const alert = this.activeAlerts.get(id);
    if (alert) {
      alert.status = 'resolved';
      await this.alertStorage.updateAlertStatus(id, 'resolved', undefined, new Date(), notes, resolvedBy);
      this.escalation.stopMonitoring(id);
      this.emit('alert-resolved', alert);
      return true;
    }
    return false;
  }

  async escalateAlert(id: string): Promise<boolean> {
    const alert = this.activeAlerts.get(id);
    if (alert) {
      alert.status = 'escalated';
      alert.escalationLevel++;
      await this.alertStorage.saveAlert(alert);
      this.notifier.sendEscalationNotification(alert);
      this.emit('alert-escalated', alert);
      return true;
    }
    return false;
  }

  getAlertStats() {
    const alerts = Array.from(this.activeAlerts.values());
    return {
      total: alerts.length,
      new: alerts.filter(a => a.status === 'new').length,
      acknowledged: alerts.filter(a => a.status === 'acknowledged').length,
      escalated: alerts.filter(a => a.status === 'escalated').length,
      resolved: alerts.filter(a => a.status === 'resolved').length,
      byPriority: {
        critical: alerts.filter(a => a.priority === AlertPriority.CRITICAL).length,
        high: alerts.filter(a => a.priority === AlertPriority.HIGH).length,
        medium: alerts.filter(a => a.priority === AlertPriority.MEDIUM).length,
        low: alerts.filter(a => a.priority === AlertPriority.LOW).length
      }
    };
  }

  async clearAllAlerts(): Promise<{ clearedInMemory: number }> {
    const clearedInMemory = this.activeAlerts.size;
    this.activeAlerts.clear();
    this.signalStateByVehicleChannel.clear();
    this.recentAlertSignatures.clear();
    this.emit('alerts-cleared', { clearedInMemory, timestamp: new Date().toISOString() });
    return { clearedInMemory };
  }

  getBufferStats() {
    const stats: any = {};
    for (const [key, buffer] of this.videoBuffers.entries()) {
      stats[key] = buffer.getStats();
    }
    return stats;
  }

  private isDriverRelatedAlert(alert: LocationAlert): boolean {
    return !!(alert.alarmFlags?.fatigue ||
             alert.alarmFlags?.dangerousDriving ||
             alert.alarmFlags?.fatigueWarning ||
             alert.drivingBehavior?.fatigue || 
             alert.drivingBehavior?.phoneCall || 
             alert.drivingBehavior?.smoking);
  }

  private extractAlertSignals(alert: LocationAlert): string[] {
    const signals: string[] = [];

    // JT/T 808 Table 24 documented alarm bits.
    // bit15~bit17 are reserved in the standard and intentionally ignored.
    const jt808BitSignalMap: Record<number, string> = {
      0: 'jt808_emergency',
      1: 'jt808_overspeed',
      2: 'jt808_fatigue',
      3: 'jt808_dangerous_driving',
      4: 'jt808_alarm_bit_4',
      5: 'jt808_alarm_bit_5',
      6: 'jt808_alarm_bit_6',
      7: 'jt808_alarm_bit_7',
      8: 'jt808_alarm_bit_8',
      9: 'jt808_alarm_bit_9',
      10: 'jt808_alarm_bit_10',
      11: 'jt808_alarm_bit_11',
      12: 'jt808_alarm_bit_12',
      13: 'jt808_overspeed_warning',
      14: 'jt808_fatigue_warning',
      18: 'jt808_alarm_bit_18',
      19: 'jt808_alarm_bit_19',
      20: 'jt808_alarm_bit_20',
      21: 'jt808_alarm_bit_21',
      22: 'jt808_alarm_bit_22',
      23: 'jt808_alarm_bit_23',
      24: 'jt808_alarm_bit_24',
      25: 'jt808_alarm_bit_25',
      26: 'jt808_alarm_bit_26',
      27: 'jt808_alarm_bit_27',
      28: 'jt808_alarm_bit_28',
      29: 'jt808_collision_warning',
      30: 'jt808_rollover_warning',
      31: 'jt808_alarm_bit_31'
    };

    const baseBits = new Set<number>(alert.alarmFlagSetBits || []);
    if (baseBits.size === 0 && alert.alarmFlags) {
      if (alert.alarmFlags.emergency) baseBits.add(0);
      if (alert.alarmFlags.overspeed) baseBits.add(1);
      if (alert.alarmFlags.fatigue) baseBits.add(2);
      if (alert.alarmFlags.dangerousDriving) baseBits.add(3);
      if (alert.alarmFlags.overspeedWarning) baseBits.add(13);
      if (alert.alarmFlags.fatigueWarning) baseBits.add(14);
      if (alert.alarmFlags.collisionWarning) baseBits.add(29);
      if (alert.alarmFlags.rolloverWarning) baseBits.add(30);
    }
    for (const bit of Array.from(baseBits).sort((a, b) => a - b)) {
      const signal = jt808BitSignalMap[bit];
      if (signal) {
        signals.push(signal);
      }
    }

    // JT/T 1078 Table 14 documented video alarm bits.
    const jtt1078VideoBitSignalMap: Record<number, string> = {
      0: 'jtt1078_video_signal_loss',
      1: 'jtt1078_video_signal_blocking',
      2: 'jtt1078_storage_failure',
      3: 'jtt1078_other_video_failure',
      4: 'jtt1078_bus_overcrowding',
      5: 'jtt1078_abnormal_driving',
      6: 'jtt1078_special_alarm_threshold'
    };

    const videoBits = new Set<number>(alert.videoAlarms?.setBits || []);
    if (videoBits.size === 0 && alert.videoAlarms) {
      if (alert.videoAlarms.videoSignalLoss) videoBits.add(0);
      if (alert.videoAlarms.videoSignalBlocking) videoBits.add(1);
      if (alert.videoAlarms.storageFailure) videoBits.add(2);
      if (alert.videoAlarms.otherVideoFailure) videoBits.add(3);
      if (alert.videoAlarms.busOvercrowding) videoBits.add(4);
      if (alert.videoAlarms.abnormalDriving) videoBits.add(5);
      if (alert.videoAlarms.specialAlarmThreshold) videoBits.add(6);
    }
    for (const bit of Array.from(videoBits).sort((a, b) => a - b)) {
      const signal = jtt1078VideoBitSignalMap[bit];
      if (signal) {
        signals.push(signal);
      } else {
        signals.push(`jtt1078_video_alarm_bit_${bit}`);
      }
    }

    if (alert.signalLossChannels?.length) {
      signals.push(`jtt1078_signal_loss_channels_${alert.signalLossChannels.join('_')}`);
    }
    if (alert.blockingChannels?.length) {
      signals.push(`jtt1078_signal_blocking_channels_${alert.blockingChannels.join('_')}`);
    }
    if (alert.memoryFailures?.main.length || alert.memoryFailures?.backup.length) {
      signals.push('jtt1078_memory_failure');
    }

    if (alert.drivingBehavior?.fatigue) signals.push('jtt1078_behavior_fatigue');
    if (alert.drivingBehavior?.phoneCall) signals.push('jtt1078_behavior_phone_call');
    if (alert.drivingBehavior?.smoking) signals.push('jtt1078_behavior_smoking');
    if ((alert.drivingBehavior?.custom || 0) > 0) signals.push(`jtt1078_behavior_custom_${alert.drivingBehavior?.custom}`);

    return Array.from(new Set(signals));
  }

  private filterActionableSignals(signals: string[]): string[] {
    // Profiles:
    // - operational (default): hide persistent infrastructure faults to surface safety/behavior alerts
    // - full/all/raw: keep every documented signal
    const profile = String(process.env.ALERT_SIGNAL_PROFILE ?? 'full').toLowerCase().trim();
    if (profile === 'full' || profile === 'all' || profile === 'raw') {
      return signals;
    }

    const suppressedExact = new Set([
      'jt808_alarm_bit_4',
      'jt808_alarm_bit_5',
      'jt808_alarm_bit_6',
      'jt808_alarm_bit_7',
      'jt808_alarm_bit_8',
      'jt808_alarm_bit_9',
      'jt808_alarm_bit_10',
      'jt808_alarm_bit_11',
      'jt808_alarm_bit_12',
      'jtt1078_video_signal_loss',
      'jtt1078_video_signal_blocking',
      'platform_video_alarm_0101',
      'platform_video_alarm_0102'
    ]);

    return signals.filter((s) => {
      if (suppressedExact.has(s)) return false;
      if (s.startsWith('jtt1078_signal_loss_channels_')) return false;
      if (s.startsWith('jtt1078_signal_blocking_channels_')) return false;
      return true;
    });
  }

  private getSignalDetail(signal: string): { code: string; label: string; meaning: string; source: string } {
    const directMap: Record<string, { label: string; meaning: string; source: string }> = {
      jt808_emergency: {
        label: 'Emergency Alarm',
        meaning: 'Terminal emergency/SOS alarm bit is set.',
        source: 'JT/T 808 alarm flag (base DWORD)'
      },
      jt808_overspeed: {
        label: 'Overspeed Alarm',
        meaning: 'Terminal reports overspeed condition.',
        source: 'JT/T 808 alarm flag (base DWORD)'
      },
      jt808_fatigue: {
        label: 'Driver Fatigue',
        meaning: 'Terminal reports fatigue driving alarm.',
        source: 'JT/T 808 alarm flag (base DWORD)'
      },
      jt808_dangerous_driving: {
        label: 'Dangerous Driving Behavior',
        meaning: 'Terminal reports dangerous driving behavior alarm.',
        source: 'JT/T 808 alarm flag (base DWORD)'
      },
      jt808_overspeed_warning: {
        label: 'Overspeed Warning',
        meaning: 'Terminal reports overspeed warning state.',
        source: 'JT/T 808 extended alarm flag'
      },
      jt808_fatigue_warning: {
        label: 'Fatigue Warning',
        meaning: 'Terminal reports fatigue warning state.',
        source: 'JT/T 808 extended alarm flag'
      },
      jt808_collision_warning: {
        label: 'Collision Warning',
        meaning: 'Terminal reports collision warning alarm.',
        source: 'JT/T 808 extended alarm flag'
      },
      jt808_rollover_warning: {
        label: 'Rollover Warning',
        meaning: 'Terminal reports rollover warning alarm.',
        source: 'JT/T 808 extended alarm flag'
      },

      jtt1078_video_signal_loss: {
        label: 'Video Signal Loss',
        meaning: 'Video channel signal-loss alarm bit is set.',
        source: 'JT/T 1078 Table 14 bit0'
      },
      jtt1078_video_signal_blocking: {
        label: 'Video Signal Blocking',
        meaning: 'Video channel masking/blocking alarm bit is set.',
        source: 'JT/T 1078 Table 14 bit1'
      },
      jtt1078_storage_failure: {
        label: 'Storage Unit Failure',
        meaning: 'Storage unit failure alarm bit is set.',
        source: 'JT/T 1078 Table 14 bit2'
      },
      jtt1078_other_video_failure: {
        label: 'Other Video Equipment Failure',
        meaning: 'Other video equipment failure alarm bit is set.',
        source: 'JT/T 1078 Table 14 bit3'
      },
      jtt1078_bus_overcrowding: {
        label: 'Bus Overcrowding',
        meaning: 'Bus overcrowding alarm bit is set.',
        source: 'JT/T 1078 Table 14 bit4'
      },
      jtt1078_abnormal_driving: {
        label: 'Abnormal Driving Behavior Alarm',
        meaning: 'Abnormal driving behavior alarm bit is set.',
        source: 'JT/T 1078 Table 14 bit5'
      },
      jtt1078_special_alarm_threshold: {
        label: 'Special Alarm Recording Threshold Reached',
        meaning: 'Special alarm recording reached storage threshold.',
        source: 'JT/T 1078 Table 14 bit6'
      },

      jtt1078_memory_failure: {
        label: 'Memory Failure Alarm',
        meaning: 'Main or backup memory failure bits are set.',
        source: 'JT/T 1078 Table 13 ID 0x17'
      },
      jtt1078_behavior_fatigue: {
        label: 'Abnormal Driving: Fatigue',
        meaning: 'Abnormal driving detail indicates fatigue.',
        source: 'JT/T 1078 Table 15 bit0'
      },
      jtt1078_behavior_phone_call: {
        label: 'Abnormal Driving: Phone Call',
        meaning: 'Abnormal driving detail indicates phone call.',
        source: 'JT/T 1078 Table 15 bit1'
      },
      jtt1078_behavior_smoking: {
        label: 'Abnormal Driving: Smoking',
        meaning: 'Abnormal driving detail indicates smoking.',
        source: 'JT/T 1078 Table 15 bit2'
      },
      platform_video_alarm_0101: {
        label: 'Video Signal Loss',
        meaning: 'Platform-level video alarm code 0x0101 reported.',
        source: 'JT/T 1078 Table 38'
      },
      platform_video_alarm_0102: {
        label: 'Video Signal Blocking',
        meaning: 'Platform-level video alarm code 0x0102 reported.',
        source: 'JT/T 1078 Table 38'
      },
      platform_video_alarm_0103: {
        label: 'Storage Unit Failure',
        meaning: 'Platform-level video alarm code 0x0103 reported.',
        source: 'JT/T 1078 Table 38'
      },
      platform_video_alarm_0104: {
        label: 'Other Video Equipment Failure',
        meaning: 'Platform-level video alarm code 0x0104 reported.',
        source: 'JT/T 1078 Table 38'
      },
      platform_video_alarm_0105: {
        label: 'Bus Overcrowding',
        meaning: 'Platform-level video alarm code 0x0105 reported.',
        source: 'JT/T 1078 Table 38'
      },
      platform_video_alarm_0106: {
        label: 'Abnormal Driving Behavior',
        meaning: 'Platform-level video alarm code 0x0106 reported.',
        source: 'JT/T 1078 Table 38'
      },
      platform_video_alarm_0107: {
        label: 'Special Alarm Recording Threshold',
        meaning: 'Platform-level video alarm code 0x0107 reported.',
        source: 'JT/T 1078 Table 38'
      }
    };

    if (directMap[signal]) {
      return { code: signal, ...directMap[signal] };
    }

    if (signal.startsWith('jt808_alarm_bit_')) {
      const bit = Number(signal.replace('jt808_alarm_bit_', ''));
      const knownBits: Record<number, { label: string; meaning: string }> = {
        0: {
          label: 'Emergency Alarm',
          meaning: 'Terminal emergency/SOS alarm bit is set.'
        },
        1: {
          label: 'Overspeed Alarm',
          meaning: 'Vehicle overspeed alarm bit is set.'
        },
        2: {
          label: 'Fatigue Driving Alarm',
          meaning: 'Fatigue driving alarm bit is set.'
        },
        3: {
          label: 'Dangerous Driving Behavior',
          meaning: 'Dangerous driving behavior alarm bit is set.'
        },
        4: {
          label: 'GNSS Module Failure',
          meaning: 'GNSS module fault alarm bit is set.'
        },
        5: {
          label: 'GNSS Antenna Disconnected',
          meaning: 'GNSS antenna open/disconnected alarm bit is set.'
        },
        6: {
          label: 'GNSS Antenna Short Circuit',
          meaning: 'GNSS antenna short-circuit alarm bit is set.'
        },
        7: {
          label: 'Main Power Undervoltage',
          meaning: 'Terminal main power undervoltage alarm bit is set.'
        },
        8: {
          label: 'Main Power Power-Down',
          meaning: 'Terminal main power down alarm bit is set.'
        },
        9: {
          label: 'Display Failure',
          meaning: 'LCD/display failure alarm bit is set.'
        },
        10: {
          label: 'TTS Module Failure',
          meaning: 'TTS module failure alarm bit is set.'
        },
        11: {
          label: 'Camera Failure',
          meaning: 'Camera failure alarm bit is set.'
        },
        12: {
          label: 'Transport IC Card Module Failure',
          meaning: 'Road transport certificate IC module failure bit is set.'
        },
        13: {
          label: 'Overspeed Warning',
          meaning: 'Overspeed warning bit is set.'
        },
        14: {
          label: 'Fatigue Warning',
          meaning: 'Fatigue warning bit is set.'
        },
        20: {
          label: 'Enter/Exit Area Alarm',
          meaning: 'Enter/exit area alarm bit is set.'
        },
        21: {
          label: 'Enter/Exit Route Alarm',
          meaning: 'Enter/exit route alarm bit is set.'
        },
        18: {
          label: 'Daily Cumulative Driving Timeout',
          meaning: 'Cumulative driving timeout alarm bit is set.'
        },
        19: {
          label: 'Parking Timeout',
          meaning: 'Parking timeout alarm bit is set.'
        },
        22: {
          label: 'Route Driving Time Abnormal',
          meaning: 'Route driving time too short/too long alarm bit is set.'
        },
        23: {
          label: 'Off-Track Alarm',
          meaning: 'Route deviation/off-track alarm bit is set.'
        },
        24: {
          label: 'Vehicle VSS Failure',
          meaning: 'Vehicle VSS fault alarm bit is set.'
        },
        25: {
          label: 'Vehicle Fuel Abnormality',
          meaning: 'Fuel abnormality alarm bit is set.'
        },
        26: {
          label: 'Vehicle Theft Alarm',
          meaning: 'Vehicle theft/burglar alarm bit is set.'
        },
        27: {
          label: 'Illegal Ignition',
          meaning: 'Illegal ignition alarm bit is set.'
        },
        28: {
          label: 'Illegal Displacement',
          meaning: 'Illegal displacement alarm bit is set.'
        },
        29: {
          label: 'Collision Warning',
          meaning: 'Collision warning alarm bit is set.'
        },
        30: {
          label: 'Rollover Warning',
          meaning: 'Rollover warning alarm bit is set.'
        },
        31: {
          label: 'Illegal Door Open',
          meaning: 'Illegal door open alarm bit is set.'
        }
      };
      const mapped = knownBits[bit] || {
        label: `JT/T 808 Alarm Bit ${bit}`,
        meaning: `Alarm bit ${bit} is set (vendor/terminal-specific if not in your adopted profile).`
      };
      return {
        code: signal,
        label: mapped.label,
        meaning: mapped.meaning,
        source: 'JT/T 808 alarm flag table'
      };
    }

    if (signal.startsWith('jtt1078_video_alarm_bit_')) {
      const bit = signal.replace('jtt1078_video_alarm_bit_', '');
      return {
        code: signal,
        label: `Video Alarm Bit ${bit}`,
        meaning: `JT/T 1078 video alarm bit ${bit} is set (outside base Table 14 bit0~bit6).`,
        source: 'JT/T 1078 Table 14 extension bit'
      };
    }

    if (signal.startsWith('jtt1078_signal_loss_channels_')) {
      const channels = signal.replace('jtt1078_signal_loss_channels_', '').split('_').join(', ');
      return {
        code: signal,
        label: 'Video Signal Loss',
        meaning: `Signal loss reported on channel(s): ${channels}.`,
        source: 'JT/T 1078 Table 13 ID 0x15'
      };
    }

    if (signal.startsWith('jtt1078_signal_blocking_channels_')) {
      const channels = signal.replace('jtt1078_signal_blocking_channels_', '').split('_').join(', ');
      return {
        code: signal,
        label: 'Video Signal Blocking',
        meaning: `Signal blocking reported on channel(s): ${channels}.`,
        source: 'JT/T 1078 Table 13 ID 0x16'
      };
    }

    if (signal.startsWith('jtt1078_behavior_custom_')) {
      const custom = signal.replace('jtt1078_behavior_custom_', '');
      return {
        code: signal,
        label: `Abnormal Driving: Custom Type ${custom}`,
        meaning: `Custom abnormal-driving type ${custom} reported by terminal.`,
        source: 'JT/T 1078 Table 15 bit11~bit15'
      };
    }

    if (signal.startsWith('external_multimedia_event_')) {
      const code = Number(signal.replace('external_multimedia_event_', ''));
      const eventMap: Record<number, { label: string; meaning: string }> = {
        2: {
          label: 'Multimedia Event: Robbery/Emergency Trigger',
          meaning: 'Terminal multimedia event indicates emergency/robbery trigger.'
        },
        3: {
          label: 'Multimedia Event: Collision/Rollover Trigger',
          meaning: 'Terminal multimedia event indicates collision/rollover trigger.'
        }
      };
      const mapped = eventMap[code] || {
        label: `Multimedia Alarm Event ${code}`,
        meaning: `Terminal reported multimedia event code ${code}.`
      };
      return {
        code: signal,
        label: mapped.label,
        meaning: mapped.meaning,
        source: 'JT/T 808 multimedia event (0x0800)'
      };
    }

    if (signal.startsWith('adas_')) {
      const mapped = getVendorAlarmBySignalCode(signal);
      return {
        code: signal,
        label: mapped?.type || signal,
        meaning: mapped?.meaning || 'ADAS vendor pass-through signal.',
        source: 'Vendor pass-through (0x0900)'
      };
    }

    if (signal.startsWith('dms_')) {
      const mapped = getVendorAlarmBySignalCode(signal);
      return {
        code: signal,
        label: mapped?.type || signal,
        meaning: mapped?.meaning || 'DMS vendor pass-through signal.',
        source: 'Vendor pass-through (0x0900)'
      };
    }

    if (signal.startsWith('behavior_')) {
      const mapped = getVendorAlarmBySignalCode(signal);
      return {
        code: signal,
        label: mapped?.type || signal,
        meaning: mapped?.meaning || 'Behavior vendor pass-through signal.',
        source: 'Vendor pass-through (0x0900)'
      };
    }

    if (signal.startsWith('custom_keyword_')) {
      const keyword = signal.replace('custom_keyword_', '').replace(/_/g, ' ');
      return {
        code: signal,
        label: `Custom Alert: ${keyword}`,
        meaning: `Keyword-derived alert extracted from custom message payload (${keyword}).`,
        source: 'Custom/proprietary terminal message'
      };
    }

    return {
      code: signal,
      label: signal,
      meaning: 'Unmapped signal code.',
      source: 'System mapping'
    };
  }

  private async requestAlertVideoFromCamera(alert: AlertEvent): Promise<void> {
    const alertTime = alert.timestamp;
    const preStartTime = new Date(alertTime.getTime() - 30 * 1000);
    const preEndTime = new Date(alertTime.getTime());
    const postStartTime = new Date(alertTime.getTime());
    const postEndTime = new Date(alertTime.getTime() + 30 * 1000);

    console.log(`Requesting camera report videos (-30s..0s and 0s..+30s) for alert ${alert.id}`);
    this.emit('request-camera-video', {
      vehicleId: alert.vehicleId,
      channel: alert.channel,
      startTime: preStartTime,
      endTime: preEndTime,
      alertId: alert.id,
      windowType: 'pre',
      audioVideoType: 2,
      streamType: 1,
      memoryType: 1,
      playbackMethod: 0
    });

    this.emit('request-camera-video', {
      vehicleId: alert.vehicleId,
      channel: alert.channel,
      startTime: postStartTime,
      endTime: postEndTime,
      alertId: alert.id,
      windowType: 'post',
      audioVideoType: 2,
      streamType: 1,
      memoryType: 1,
      playbackMethod: 0
    });

  }
}
