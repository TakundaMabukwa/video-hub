import { JTT1078RTPParser } from '../udp/rtpParser';
import { FrameAssembler } from '../udp/frameAssembler';
import { VideoWriter } from '../video/writer';
import { HLSStreamer } from '../streaming/hls';
import { AlertManager, AlertPriority } from '../alerts/alertManager';
import { RawIngestLogger } from '../logging/rawIngestLogger';

export class TCPRTPHandler {
  private frameAssembler = new FrameAssembler();
  private videoWriter = new VideoWriter();
  private hlsStreamer = new HLSStreamer();
  private frameCount = 0;
  private activeStreams = new Set<string>();
  private onFrameCallback?: (vehicleId: string, channel: number, frame: Buffer, isIFrame: boolean) => void;
  private alertManager?: AlertManager;

  setFrameCallback(callback: (vehicleId: string, channel: number, frame: Buffer, isIFrame: boolean) => void): void {
    this.onFrameCallback = callback;
  }

  setAlertManager(alertManager: AlertManager): void {
    this.alertManager = alertManager;
  }

  handleRTPPacket(buffer: Buffer, vehicleId: string): void {
    const parsed = JTT1078RTPParser.parseRTPPacket(buffer);
    if (!parsed) {
      console.log(`[RTP] Failed to parse packet from ${vehicleId}`);
      return;
    }

    const { header, payload, dataType } = parsed;
    const streamKey = `${vehicleId}_${header.channelNumber}`;

    // JT/T 1078 transparent data stream can carry vendor alarms (ADAS/DMS).
    // Do not route transparent payload into video pipeline.
    if (dataType === 0x04) {
      this.handleTransparentAlertPayload(vehicleId, header.channelNumber, payload);
      return;
    }

    if (!this.activeStreams.has(streamKey)) {
      this.hlsStreamer.startStream(vehicleId, header.channelNumber);
      this.activeStreams.add(streamKey);
      console.log(`[RTP] HLS stream started: ${streamKey}`);
    }

    const completeFrame = this.frameAssembler.assembleFrame(header, payload, dataType);
    if (!completeFrame) return;

    this.frameCount++;
    const isIFrame = this.isIFrame(completeFrame);

    if (this.alertManager) {
      this.alertManager.addFrameToBuffer(
        vehicleId,
        header.channelNumber,
        completeFrame,
        new Date(),
        isIFrame
      );
    }

    if (this.onFrameCallback) {
      this.onFrameCallback(vehicleId, header.channelNumber, completeFrame, isIFrame);
    }

    this.hlsStreamer.writeFrame(vehicleId, header.channelNumber, completeFrame);
    this.videoWriter.writeFrame(vehicleId, header.channelNumber, completeFrame);

    if (this.frameCount === 1) {
      console.log(`[RTP] First video frame from ${vehicleId} channel ${header.channelNumber}`);
    }
  }

  private handleTransparentAlertPayload(vehicleId: string, channel: number, payload: Buffer): void {
    if (!this.alertManager || !payload || payload.length === 0) return;

    const text = payload
      .toString('latin1')
      .replace(/[^\x20-\x7E]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const mapped = this.mapTransparentAlert(payload, text);
    RawIngestLogger.write('jtt1078_transparent_payload_tcp', {
      vehicleId,
      channel,
      dataType: 0x04,
      payloadText: text.slice(0, 320),
      rawPayloadHex: payload.toString('hex'),
      mapped: !!mapped,
      mappedType: mapped?.type || null,
      mappedSignalCode: mapped?.signalCode || null,
      mappedAlarmCode: mapped?.alarmCode ?? null
    });

    if (!mapped) return;

    void this.alertManager.processExternalAlert({
      vehicleId,
      channel: channel || 1,
      type: mapped.type,
      signalCode: mapped.signalCode,
      priority: mapped.priority,
      timestamp: new Date(),
      metadata: {
        sourceMessageId: 'jtt1078_rtp_transparent',
        dataType: 0x04,
        alarmCode: mapped.alarmCode ?? null,
        payloadText: text.slice(0, 320),
        rawPayloadHex: payload.toString('hex').slice(0, 1024)
      }
    });
  }

  private mapTransparentAlert(
    payload: Buffer,
    text: string
  ): { type: string; priority: AlertPriority; signalCode: string; alarmCode?: number } | null {
    const textMapped = this.mapVendorAlertText(text);
    if (textMapped) return textMapped;

    const codeFromText = this.extractVendorCode(text);
    if (codeFromText !== null) {
      const mapped = this.mapVendorCode(codeFromText);
      if (mapped) return { ...mapped, alarmCode: codeFromText };
    }

    if (payload.length >= 2) {
      const be = payload.readUInt16BE(0);
      const mappedBe = this.mapVendorCode(be);
      if (mappedBe) return { ...mappedBe, alarmCode: be };

      const le = payload.readUInt16LE(0);
      const mappedLe = this.mapVendorCode(le);
      if (mappedLe) return { ...mappedLe, alarmCode: le };
    }

    return null;
  }

  private extractVendorCode(text: string): number | null {
    if (!text) return null;
    const hexMatch = text.match(/\b0x([0-9a-f]{4})\b/i);
    if (hexMatch) return parseInt(hexMatch[1], 16);
    const match = text.match(/\b(1000[1-8]|10016|10017|1010[1-7]|10116|10117|1120[1-3])\b/);
    return match ? Number(match[1]) : null;
  }

  private mapVendorAlertText(
    text: string
  ): { type: string; priority: AlertPriority; signalCode: string } | null {
    if (!text) return null;
    const patterns: Array<{ re: RegExp; type: string; priority: AlertPriority; signalCode: string }> = [
      { re: /\bseat\s*belt\s*detected\b/i, type: 'Seatbelt Detection', priority: AlertPriority.MEDIUM, signalCode: 'vendor_seatbelt_detected' },
      { re: /\bno\s+driver\s+detected\b/i, type: 'No Driver Detected', priority: AlertPriority.HIGH, signalCode: 'vendor_no_driver_detected' },
      { re: /\bcamera\s+(obstructed|blocked|covered)\b/i, type: 'Camera Obstructed', priority: AlertPriority.HIGH, signalCode: 'vendor_camera_obstructed' },
      { re: /\bidle\s+alert\b/i, type: 'Idle Alert', priority: AlertPriority.MEDIUM, signalCode: 'vendor_idle_alert' },
      { re: /\bfatigue\s+driving\s+alarm\b/i, type: 'DMS: Fatigue driving alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10101_fatigue_driving_alarm' },
      { re: /\bhandheld\s+phone\s+alarm\b/i, type: 'DMS: Handheld phone alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10102_handheld_phone_alarm' },
      { re: /\bsmoking\s+alarm\b/i, type: 'DMS: Smoking alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10103_smoking_alarm' },
      { re: /\bforward\s+collision\s+warning\b/i, type: 'ADAS: Forward collision warning', priority: AlertPriority.CRITICAL, signalCode: 'adas_10001_forward_collision_warning' },
      { re: /\blane\s+departure\s+alarm\b/i, type: 'ADAS: Lane departure alarm', priority: AlertPriority.HIGH, signalCode: 'adas_10002_lane_departure_alarm' }
    ];
    const hit = patterns.find((p) => p.re.test(text));
    return hit ? { type: hit.type, priority: hit.priority, signalCode: hit.signalCode } : null;
  }

  private mapVendorCode(code: number): { type: string; priority: AlertPriority; signalCode: string } | null {
    const map: Record<number, { type: string; priority: AlertPriority; signalCode: string }> = {
      10001: { type: 'ADAS: Forward collision warning', priority: AlertPriority.CRITICAL, signalCode: 'adas_10001_forward_collision_warning' },
      10002: { type: 'ADAS: Lane departure alarm', priority: AlertPriority.HIGH, signalCode: 'adas_10002_lane_departure_alarm' },
      10003: { type: 'ADAS: Following distance too close', priority: AlertPriority.HIGH, signalCode: 'adas_10003_following_distance_too_close' },
      10004: { type: 'ADAS: Pedestrian collision alarm', priority: AlertPriority.CRITICAL, signalCode: 'adas_10004_pedestrian_collision_alarm' },
      10005: { type: 'ADAS: Frequent lane change alarm', priority: AlertPriority.HIGH, signalCode: 'adas_10005_frequent_lane_change_alarm' },
      10006: { type: 'ADAS: Road sign over-limit alarm', priority: AlertPriority.MEDIUM, signalCode: 'adas_10006_road_sign_over_limit_alarm' },
      10007: { type: 'ADAS: Obstruction alarm', priority: AlertPriority.MEDIUM, signalCode: 'adas_10007_obstruction_alarm' },
      10008: { type: 'ADAS: Driver assistance function failure alarm', priority: AlertPriority.MEDIUM, signalCode: 'adas_10008_driver_assist_function_failure' },
      10016: { type: 'ADAS: Road sign identification event', priority: AlertPriority.LOW, signalCode: 'adas_10016_road_sign_identification_event' },
      10017: { type: 'ADAS: Active capture event', priority: AlertPriority.LOW, signalCode: 'adas_10017_active_capture_event' },
      10101: { type: 'DMS: Fatigue driving alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10101_fatigue_driving_alarm' },
      10102: { type: 'DMS: Handheld phone alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10102_handheld_phone_alarm' },
      10103: { type: 'DMS: Smoking alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10103_smoking_alarm' },
      10104: { type: 'DMS: Forward camera invisible too long', priority: AlertPriority.HIGH, signalCode: 'dms_10104_forward_invisible_too_long' },
      10105: { type: 'DMS: Driver alarm not detected', priority: AlertPriority.MEDIUM, signalCode: 'dms_10105_driver_alarm_not_detected' },
      10106: { type: 'DMS: Both hands off steering wheel', priority: AlertPriority.HIGH, signalCode: 'dms_10106_hands_off_steering' },
      10107: { type: 'DMS: Driver behavior monitoring failure', priority: AlertPriority.MEDIUM, signalCode: 'dms_10107_behavior_monitoring_failure' },
      10116: { type: 'DMS: Automatic capture event', priority: AlertPriority.LOW, signalCode: 'dms_10116_automatic_capture_event' },
      10117: { type: 'DMS: Driver change', priority: AlertPriority.LOW, signalCode: 'dms_10117_driver_change' },
      11201: { type: 'Rapid acceleration', priority: AlertPriority.MEDIUM, signalCode: 'behavior_11201_rapid_acceleration' },
      11202: { type: 'Rapid deceleration', priority: AlertPriority.MEDIUM, signalCode: 'behavior_11202_rapid_deceleration' },
      11203: { type: 'Sharp turn', priority: AlertPriority.MEDIUM, signalCode: 'behavior_11203_sharp_turn' }
    };
    return map[code] || null;
  }

  private isIFrame(frame: Buffer): boolean {
    for (let i = 0; i < frame.length - 4; i++) {
      if (frame[i] === 0x00 && frame[i + 1] === 0x00 &&
          frame[i + 2] === 0x00 && frame[i + 3] === 0x01) {
        const nalType = frame[i + 4] & 0x1f;
        if (nalType === 5) return true;
      }
    }
    return false;
  }

  stopStream(vehicleId: string, channel: number): void {
    const streamKey = `${vehicleId}_${channel}`;
    this.hlsStreamer.stopStream(vehicleId, channel);
    this.activeStreams.delete(streamKey);
  }

  getStats() {
    return {
      frameCount: this.frameCount,
      activeStreams: this.activeStreams.size,
      ...this.frameAssembler.getStats()
    };
  }
}
