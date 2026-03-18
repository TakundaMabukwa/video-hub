import { AbnormalDrivingBehavior, VideoAlarmStatus, LocationAlert, AlarmFlags, VendorAdditionalInfoExtension } from '../types/jtt';
import { getKnownVendorCodes } from '../protocol/vendorAlarmCatalog';

export class AlertParser {
  private static resolveTerminalTimezoneOffsetHours(): number {
    const raw = process.env.JTT808_TERMINAL_TZ_OFFSET_HOURS ?? process.env.TERMINAL_TZ_OFFSET_HOURS;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      // Keep protocol-default behavior unless deployment overrides it.
      return 8;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 8;
    return parsed;
  }

  static parseLocationReport(body: Buffer, vehicleId: string): LocationAlert | null {
    if (body.length < 28) return null;

    // Basic location data (first 28 bytes)
    const alarmFlag = body.readUInt32BE(0);
    const statusFlag = body.readUInt32BE(4);
    const latitude = body.readUInt32BE(8) / 1000000;
    const longitude = body.readUInt32BE(12) / 1000000;
    const altitude = body.readUInt16BE(16);
    const speed = body.readUInt16BE(18) / 10; // Convert from 0.1 km/h to km/h
    const direction = body.readUInt16BE(20);
    const timestamp = this.parseTimestamp(body.slice(22, 28));

    const alert: LocationAlert = {
      vehicleId,
      timestamp,
      latitude,
      longitude,
      speed,
      direction,
      altitude,
      alarmFlags: this.parseAlarmFlags(alarmFlag),
      alarmFlagSetBits: this.getSetBits(alarmFlag, 32),
      rawAlarmFlag: alarmFlag,
      rawStatusFlag: statusFlag
    };

    // Parse additional information (after byte 28)
    let offset = 28;
    while (offset < body.length - 2) {
      const infoId = body.readUInt8(offset);
      const infoLength = body.readUInt8(offset + 1);
      
      if (offset + 2 + infoLength > body.length) break;
      
      const infoData = body.slice(offset + 2, offset + 2 + infoLength);
      
      switch (infoId) {
        case 0x14: // Video-related alarm
          alert.videoAlarms = this.parseVideoAlarms(infoData);
          break;
        case 0x15: // Video signal loss per channel
          alert.signalLossChannels = this.parseChannelBits(infoData);
          break;
        case 0x16: // Video signal blocking per channel
          alert.blockingChannels = this.parseChannelBits(infoData);
          break;
        case 0x17: // Memory failure status
          alert.memoryFailures = this.parseMemoryFailures(infoData);
          break;
        case 0x18: // Abnormal driving behavior details
          alert.drivingBehavior = this.parseAbnormalDriving(infoData);
          break;
        case 0x64: // Proprietary/active-safety ADAS extension (deployment-specific)
          this.pushVendorExtension(alert, infoId, infoData, 'ADAS');
          break;
        case 0x65: // Proprietary/active-safety DMS extension (deployment-specific)
          this.pushVendorExtension(alert, infoId, infoData, 'DMS');
          break;
      }
      
      offset += 2 + infoLength;
    }

    return alert;
  }

  private static parseVideoAlarms(data: Buffer): VideoAlarmStatus {
    if (data.length < 4) return {} as VideoAlarmStatus;
    
    const flags = data.readUInt32BE(0);
    return {
      videoSignalLoss: !!(flags & (1 << 0)),
      videoSignalBlocking: !!(flags & (1 << 1)),
      storageFailure: !!(flags & (1 << 2)),
      otherVideoFailure: !!(flags & (1 << 3)),
      busOvercrowding: !!(flags & (1 << 4)),
      abnormalDriving: !!(flags & (1 << 5)),
      specialAlarmThreshold: !!(flags & (1 << 6)),
      setBits: this.getSetBits(flags, 32)
    };
  }

  private static parseChannelBits(data: Buffer): number[] {
    if (data.length < 4) return [];
    
    const bits = data.readUInt32BE(0);
    const channels: number[] = [];
    
    for (let i = 0; i < 32; i++) {
      if (bits & (1 << i)) {
        channels.push(i + 1); // Channels are 1-based
      }
    }
    
    return channels;
  }

  private static parseMemoryFailures(data: Buffer): { main: number[]; backup: number[]; } {
    if (data.length < 2) return { main: [], backup: [] };
    
    const bits = data.readUInt16BE(0);
    const main: number[] = [];
    const backup: number[] = [];
    
    // Bits 0-11: main memory units 1-12
    for (let i = 0; i < 12; i++) {
      if (bits & (1 << i)) {
        main.push(i + 1);
      }
    }
    
    // Bits 12-15: backup memory units 1-4
    for (let i = 12; i < 16; i++) {
      if (bits & (1 << i)) {
        backup.push(i - 11);
      }
    }
    
    return { main, backup };
  }

  private static parseAbnormalDriving(data: Buffer): AbnormalDrivingBehavior {
    // JT/T 1078 Table 13 defines 0x18 as WORD (2 bytes).
    // Some vendors append extra bytes; if present we treat byte 2 as optional fatigue level.
    if (data.length < 2) {
      return {
        fatigue: false,
        phoneCall: false,
        smoking: false,
        custom: 0,
        fatigueLevel: 0
      };
    }

    const behaviorFlags = data.readUInt16BE(0);
    const fatigueLevel = data.length >= 3 ? data.readUInt8(2) : 0;

    return {
      fatigue: !!(behaviorFlags & (1 << 0)),     // bit0: fatigue
      phoneCall: !!(behaviorFlags & (1 << 1)),   // bit1: call
      smoking: !!(behaviorFlags & (1 << 2)),     // bit2: smoking
      custom: (behaviorFlags >> 11) & 0x1F,      // bits 11-15: custom
      fatigueLevel
    };
  }

  private static parseAlarmFlags(alarmFlag: number): AlarmFlags {
    return {
      emergency: !!(alarmFlag & (1 << 0)),
      overspeed: !!(alarmFlag & (1 << 1)),
      fatigue: !!(alarmFlag & (1 << 2)),
      dangerousDriving: !!(alarmFlag & (1 << 3)),
      overspeedWarning: !!(alarmFlag & (1 << 13)),
      fatigueWarning: !!(alarmFlag & (1 << 14)),
      // JT/T 808 Table 24: collision warning is bit29 (bit31 is illegal door open)
      collisionWarning: !!(alarmFlag & (1 << 29)),
      // JT/T 808 Table 24: rollover warning is bit30
      rolloverWarning: !!(alarmFlag & (1 << 30))
    };
  }

  private static pushVendorExtension(
    alert: LocationAlert,
    infoId: number,
    data: Buffer,
    domain: 'ADAS' | 'DMS'
  ): void {
    const extension: VendorAdditionalInfoExtension = {
      infoId,
      rawHex: data.toString('hex'),
      detectedCodes: this.extractKnownVendorCodes(data, {
        allowBinaryWordScan: false,
        allowPlatformVideoCodes: false
      }),
      domain
    };
    if (domain === 'ADAS' || domain === 'DMS') {
      Object.assign(extension, this.parseActiveSafetyAdditionalInfo(data));
    }
    if (!Array.isArray(alert.vendorExtensions)) {
      alert.vendorExtensions = [];
    }
    alert.vendorExtensions.push(extension);
  }

  private static parseActiveSafetyAdditionalInfo(data: Buffer): Partial<VendorAdditionalInfoExtension> {
    // Official 0x64/0x65 active-safety additional info layout observed in deployment docs:
    // alarmId(4) + flag(1) + eventType(1) + level(1) + context fields + snapshot + identification.
    if (!data || data.length < 7) return {};

    const parsed: Partial<VendorAdditionalInfoExtension> = {
      alarmId: data.readUInt32BE(0),
      flagStatus: data.readUInt8(4),
      eventType: data.readUInt8(5),
      alarmLevel: data.readUInt8(6)
    };

    if (data.length >= 13) {
      parsed.frontObjectSpeed = data.readUInt8(7);
      parsed.frontObjectDistance = data.readUInt8(8);
      parsed.deviationType = data.readUInt8(9);
      parsed.roadSignType = data.readUInt8(10);
      parsed.roadSignData = data.readUInt8(11);
      parsed.sourceSpeed = data.readUInt8(12);
    }

    if (data.length >= 29) {
      parsed.sourceAltitude = data.readUInt16BE(13);
      parsed.sourceLatitude = data.readUInt32BE(15) / 1000000;
      parsed.sourceLongitude = data.readUInt32BE(19) / 1000000;
      parsed.sourceTimestamp = this.parseTimestamp(data.slice(23, 29));
    }

    if (data.length >= 31) {
      parsed.vehicleStatus = data.readUInt16BE(29);
    }

    if (data.length >= 47) {
      parsed.identification = {
        terminalId: data.slice(31, 38).toString('ascii').replace(/\0+$/, ''),
        timestamp: this.parseTimestamp(data.slice(38, 44)),
        sequenceNumber: data.readUInt8(44),
        attachmentCount: data.readUInt8(45),
        reserved: data.readUInt8(46)
      };
    }

    return parsed;
  }

  private static extractKnownVendorCodes(
    data: Buffer,
    options?: { allowBinaryWordScan?: boolean; allowPlatformVideoCodes?: boolean }
  ): number[] {
    if (!data || data.length === 0) return [];
    const known = getKnownVendorCodes();
    const found = new Set<number>();
    const allowBinaryWordScan = options?.allowBinaryWordScan ?? true;
    const allowPlatformVideoCodes = options?.allowPlatformVideoCodes ?? true;

    if (allowBinaryWordScan) {
      for (let i = 0; i <= data.length - 2; i++) {
        const be = data.readUInt16BE(i);
        if (known.has(be) && (allowPlatformVideoCodes || be >= 10000)) found.add(be);
        const le = data.readUInt16LE(i);
        if (known.has(le) && (allowPlatformVideoCodes || le >= 10000)) found.add(le);
      }
    }

    const text = data
      .toString('latin1')
      .replace(/[^\x20-\x7E]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const matches = text.match(/\b(1000[1-8]|10016|10017|1010[1-7]|10116|10117|1120[1-3])\b/g) || [];
    for (const match of matches) {
      const code = Number(match);
      if (known.has(code)) found.add(code);
    }

    return Array.from(found).sort((a, b) => a - b);
  }

  private static bcdToDec(value: number): number {
    return ((value >> 4) & 0x0F) * 10 + (value & 0x0F);
  }

  private static getSetBits(value: number, maxBits: number): number[] {
    const bits: number[] = [];
    for (let i = 0; i < maxBits; i++) {
      if (value & (1 << i)) bits.push(i);
    }
    return bits;
  }

  private static parseTimestamp(data: Buffer): Date {
    // BCD format: YY-MM-DD-HH-MM-SS (spec timestamps are GMT+8)
    const year = 2000 + this.bcdToDec(data[0]);
    const month = this.bcdToDec(data[1]);
    const day = this.bcdToDec(data[2]);
    const hour = this.bcdToDec(data[3]);
    const minute = this.bcdToDec(data[4]);
    const second = this.bcdToDec(data[5]);
    const offsetHours = this.resolveTerminalTimezoneOffsetHours();
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - (offsetHours * 60 * 60 * 1000);

    return new Date(utcMs);
  }
}
