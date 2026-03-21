import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { JTT808Parser } from './parser';
import { JTT1078RTPParser } from '../udp/rtpParser';
import { JTT1078Commands } from './commands';
import { ScreenshotCommands } from './screenshotCommands';
import { AlertParser } from './alertParser';
import { MultimediaParser } from './multimediaParser';
import { AlertVideoCommands } from './alertVideoCommands';
import { AlertStorageDB } from '../storage/alertStorageDB';
import { DeviceStorage } from '../storage/deviceStorage';
import { ImageStorage } from '../storage/imageStorage';
import { AlertManager, AlertPriority } from '../alerts/alertManager';
import { RawIngestLogger } from '../logging/rawIngestLogger';
import { ProtocolMessageArchive } from '../logging/protocolMessageArchive';
import { JTT808MessageType, Vehicle, LocationAlert, VehicleChannel } from '../types/jtt';
import { getKnownVendorCodes, getVendorAlarmByCode, getVendorAlarmCatalog } from '../protocol/vendorAlarmCatalog';
import { ProtocolMessageStorage } from '../storage/protocolMessageStorage';

type ScreenshotFallbackResult = {
  ok: boolean;
  imageId?: string;
  reason?: string;
  videoEvidencePath?: string;
  videoEvidenceReason?: string;
};

type ResourceVideoItem = {
  channel: number;
  startTime: string;
  endTime: string;
  alarmFlag64Hex: string;
  alarmBits: number[];
  alarmLabels: string[];
  alarmType: number;
  mediaType: number;
  streamType: number;
  storageType: number;
  fileSize: number;
};

type PendingResourceList = {
  createdAt: number;
  packetCount: number;
  parts: Map<number, Buffer>;
};

type MessageTraceEntry = {
  id: number;
  receivedAt: string;
  direction?: 'inbound' | 'outbound';
  vehicleId: string;
  messageId: number;
  messageIdHex: string;
  serialNumber: number;
  bodyLength: number;
  isSubpackage: boolean;
  packetCount?: number;
  packetIndex?: number;
  rawFrameHex: string;
  bodyHex: string;
  bodyTextPreview: string;
  parse?: Record<string, unknown>;
};

type PendingCameraRequest = {
  vehicleId: string;
  channel: number;
  startTime: string;
  endTime: string;
  queryResources: boolean;
  requestDownload: boolean;
  createdAt: number;
};

type PendingScreenshotRequest = {
  alertId: string;
  channel: number;
  createdAt: number;
};

type VendorExtractionMethod =
  | 'numeric_be'
  | 'numeric_le'
  | 'ascii_code'
  | 'framed_peripheral'
  | 'text_numeric'
  | 'text_label';
type VendorConfidence = 'high' | 'medium' | 'low';

type VendorMappedAlert = {
  type: string;
  priority: AlertPriority;
  signalCode: string;
  channel?: number;
  alarmCode?: number;
  extractionMethod?: VendorExtractionMethod;
  confidence?: VendorConfidence;
  sourceType?: 'pass_through' | 'location_extension' | 'global_payload';
  domain?: string;
};

type VehicleIdentity = {
  vehicleId: string;
  terminalPhone: string;
  ipAddress?: string;
  registeredAt?: string;
  provinceId?: number;
  cityId?: number;
  manufacturerId?: string;
  terminalModel?: string;
  terminalId?: string;
  plateColor?: number;
  plateNumber?: string;
};

export class JTT808Server {
  private server: net.Server;
  private vehicles = new Map<string, Vehicle>();
  private connections = new Map<string, net.Socket>();
  private socketToVehicle = new Map<net.Socket, string>();
  private ipToVehicle = new Map<string, string>(); // Map IP to vehicle ID
  private serialCounter = 1;
  private rtpHandler?: (buffer: Buffer, vehicleId: string) => void;
  private alertStorage = new AlertStorageDB();
  private deviceStorage = new DeviceStorage();
  private imageStorage = new ImageStorage();
  private alertManager: AlertManager;
  private latestResourceLists = new Map<string, { receivedAt: number; items: ResourceVideoItem[] }>();
  private pendingResourceLists = new Map<string, PendingResourceList>();
  private lastKnownLocation = new Map<string, { latitude: number; longitude: number; timestamp: Date }>();
  private messageTraceSeq = 0;
  private recentMessageTraces: MessageTraceEntry[] = [];
  private protocolMessageStorage = new ProtocolMessageStorage();
  private pendingCameraRequests = new Map<string, PendingCameraRequest[]>();
  private pendingScreenshotRequests = new Map<string, PendingScreenshotRequest[]>();
  private vehicleIdentityById = new Map<string, VehicleIdentity>();
  private messageTraceCallback?: (trace: MessageTraceEntry) => void;
  private boundAlertManagerForCommands?: AlertManager;
  private boundRequestScreenshotHandler?: (payload: any) => void;
  private boundRequestCameraVideoHandler?: (payload: any) => void;
  private readonly vendorDecoderVersion = 'vendor-catalog-v1';
  private vendorAlertTelemetry = {
    emittedBySourceCode: new Map<string, number>(),
    suppressedByReason: new Map<string, number>(),
    parseFailuresByReason: new Map<string, number>()
  };
  private readonly maxMessageTraceBuffer = Math.max(
    50,
    Number(process.env.MESSAGE_TRACE_BUFFER_SIZE || 300)
  );
  private readonly messageTraceEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(
      process.env.MESSAGE_TRACE_ENABLED ??
        (process.env.ALERT_PROCESSING_ENABLED === 'false' && process.env.VIDEO_PROCESSING_ENABLED === 'false'
          ? 'false'
          : 'true')
    ).trim().toLowerCase()
  );
  private readonly verboseIngressLogs = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.VERBOSE_INGRESS_LOGS ?? 'false').trim().toLowerCase()
  );
  private readonly verboseLocationLogs = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.VERBOSE_LOCATION_LOGS ?? 'false').trim().toLowerCase()
  );
  private readonly videoProcessingEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.VIDEO_PROCESSING_ENABLED ?? 'true').trim().toLowerCase()
  );
  private noisyLogGate = new Map<string, number>();

  private getNextSerial(): number {
    this.serialCounter = (this.serialCounter % 65535) + 1;
    return this.serialCounter;
  }

  constructor(private port: number, private udpPort: number) {
    this.server = net.createServer(this.handleConnection.bind(this));
    this.alertManager = new AlertManager();
  }

  getAlertManager(): AlertManager {
    return this.alertManager;
  }

  setAlertManager(alertManager: AlertManager): void {
    this.detachAlertCommandBridge();
    this.alertManager = alertManager;
  }

  attachAlertCommandBridge(alertManager: AlertManager = this.alertManager): void {
    this.detachAlertCommandBridge();

    this.boundAlertManagerForCommands = alertManager;
    this.boundRequestScreenshotHandler = ({ vehicleId, channel, alertId }) => {
      const channels = this.resolveAlertCaptureChannels(vehicleId, channel);
      for (const ch of channels) {
        console.log(`Alert ${alertId}: Requesting screenshot from ${vehicleId} channel ${ch}`);
        void this.requestScreenshotWithFallback(vehicleId, ch, {
          fallback: true,
          fallbackDelayMs: 700,
          alertId,
          captureVideoEvidence: true,
          videoDurationSec: 8
        });
      }
    };
    this.boundRequestCameraVideoHandler = ({ vehicleId, channel, startTime, endTime, alertId }) => {
      const channels = this.resolveAlertCaptureChannels(vehicleId, channel);
      for (const ch of channels) {
        console.log(`Alert ${alertId}: Requesting camera SD card video from ${vehicleId} channel ${ch}`);
        this.scheduleCameraReportRequests(vehicleId, ch, startTime, endTime, {
          queryResources: true,
          requestDownload: false
        });
      }
    };

    alertManager.on('request-screenshot', this.boundRequestScreenshotHandler);
    alertManager.on('request-camera-video', this.boundRequestCameraVideoHandler);
  }

  private detachAlertCommandBridge(): void {
    if (this.boundAlertManagerForCommands && this.boundRequestScreenshotHandler) {
      this.boundAlertManagerForCommands.off('request-screenshot', this.boundRequestScreenshotHandler);
    }
    if (this.boundAlertManagerForCommands && this.boundRequestCameraVideoHandler) {
      this.boundAlertManagerForCommands.off('request-camera-video', this.boundRequestCameraVideoHandler);
    }
    this.boundAlertManagerForCommands = undefined;
    this.boundRequestScreenshotHandler = undefined;
    this.boundRequestCameraVideoHandler = undefined;
  }

  private shouldLogNoisy(key: string, throttleMs: number = 10000): boolean {
    const now = Date.now();
    const last = this.noisyLogGate.get(key) || 0;
    if (now - last < throttleMs) return false;
    this.noisyLogGate.set(key, now);
    return true;
  }

  getVendorAlertCatalog() {
    return getVendorAlarmCatalog().map((entry) => ({
      ...entry,
      codeHex: `0x${entry.code.toString(16)}`
    }));
  }

  getVendorAlertTelemetry() {
    const mapToObject = (map: Map<string, number>) =>
      Array.from(map.entries()).reduce<Record<string, number>>((acc, [k, v]) => {
        acc[k] = v;
        return acc;
      }, {});

    return {
      decoderVersion: this.vendorDecoderVersion,
      emittedBySourceCode: mapToObject(this.vendorAlertTelemetry.emittedBySourceCode),
      suppressedByReason: mapToObject(this.vendorAlertTelemetry.suppressedByReason),
      parseFailuresByReason: mapToObject(this.vendorAlertTelemetry.parseFailuresByReason)
    };
  }

  private bumpVendorTelemetry(
    bucket: keyof JTT808Server['vendorAlertTelemetry'],
    key: string
  ): void {
    const store = this.vendorAlertTelemetry[bucket];
    store.set(key, (store.get(key) || 0) + 1);
  }

  private isStrictAlertMode(): boolean {
    const mode = String(process.env.ALERT_MODE || 'strict').trim().toLowerCase();
    return mode === 'strict';
  }

  private buildPayloadHash(payload: Buffer): string {
    if (!payload || payload.length === 0) return '';
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private isVendorAlertEmittable(mapped: VendorMappedAlert): boolean {
    if (!this.isStrictAlertMode()) return true;
    const confidence = mapped.confidence || 'low';
    if (confidence !== 'high') {
      this.bumpVendorTelemetry('suppressedByReason', `strict_non_high_confidence_${confidence}`);
      return false;
    }
    return true;
  }

  setRTPHandler(handler: (buffer: Buffer, vehicleId: string) => void): void {
    this.rtpHandler = handler;
  }

  setMessageTraceCallback(handler: (trace: MessageTraceEntry) => void): void {
    this.messageTraceCallback = handler;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`JT/T 808 TCP server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    let buffer = Buffer.alloc(0);
    
    socket.on('data', async (data) => {
      if (this.verboseIngressLogs) {
        console.log(`[${clientAddr}] ${data.length}B: ${data.toString('hex').substring(0, 100)}${data.length > 50 ? '...' : ''}`);
      }
      buffer = Buffer.concat([buffer, data]);
      
      const rtpMagic = Buffer.from([0x30, 0x31, 0x63, 0x64]);

      // Process complete messages
      while (buffer.length > 0) {
        // Skip duplicated delimiters (some devices send 0x7E 0x7E between frames)
        while (buffer.length >= 2 && buffer[0] === 0x7E && buffer[1] === 0x7E) {
          buffer = buffer.slice(1);
        }

        // Check for RTP video data first (0x30316364)
        if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x30316364) {
          // Parse data type at offset 15 to determine header size
          if (buffer.length < 16) break; // Need at least 16 bytes
          
          const dataTypeByte = buffer.readUInt8(15);
          const dataType = (dataTypeByte >> 4) & 0x0F;
          
          // Calculate payload length offset based on data type
          let payloadLengthOffset = 16;
          if (dataType !== 0x04) {
            payloadLengthOffset += 8; // timestamp
            if (dataType <= 0x02) {
              payloadLengthOffset += 4; // I-frame + frame intervals
            }
          }
          
          if (buffer.length < payloadLengthOffset + 2) break; // Need payload length field
          
          const payloadLength = buffer.readUInt16BE(payloadLengthOffset);
          const totalLength = payloadLengthOffset + 2 + payloadLength;
          
          if (buffer.length >= totalLength) {
            const rtpPacket = buffer.slice(0, totalLength);
            buffer = buffer.slice(totalLength);
            this.handleRTPData(rtpPacket, socket);
            continue;
          }
          break; // Wait for more data
        }

        // Check for JT/T 808 frame when aligned to delimiter
        if (buffer[0] === 0x7E) {
          const messageEnd = buffer.indexOf(0x7E, 1);
          if (messageEnd === -1) break;

          const frameLength = messageEnd + 1;
          // Guardrail: malformed oversized/undersized frame; resync by one byte.
          if (frameLength < 15 || frameLength > 8192) {
            buffer = buffer.slice(1);
            continue;
          }

          const messageBuffer = buffer.slice(0, frameLength);
          buffer = buffer.slice(frameLength);

          await this.processMessage(messageBuffer, socket);
          continue;
        }

        // Not aligned to either protocol; resync to the nearest known marker.
        const next808 = buffer.indexOf(0x7E);
        const nextRtp = buffer.indexOf(rtpMagic);

        if (next808 === -1 && nextRtp === -1) {
          buffer = Buffer.alloc(0);
          break;
        }

        let next = -1;
        if (next808 === -1) next = nextRtp;
        else if (nextRtp === -1) next = next808;
        else next = Math.min(next808, nextRtp);

        if (next <= 0) {
          // Safety fallback: drop one byte to avoid infinite loops.
          buffer = buffer.slice(1);
        } else {
          buffer = buffer.slice(next);
        }
      }
    });

    socket.on('close', () => {
      
      this.handleDisconnection(socket);
    });

    socket.on('error', (error) => {
      console.error(`TCP socket error:`, error);
    });
  }

  private async processMessage(buffer: Buffer, socket: net.Socket): Promise<void> {
    const message = JTT808Parser.parseMessage(buffer);
    if (!message) {
      ProtocolMessageArchive.write({
        ts: new Date().toISOString(),
        direction: 'inbound',
        remoteAddress: socket.remoteAddress || null,
        remotePort: socket.remotePort || null,
        vehicleId: null,
        messageId: null,
        messageIdHex: null,
        serialNumber: null,
        bodyLength: null,
        isSubpackage: false,
        parseSuccess: false,
        parseError: 'parse_failed',
        rawFrameHex: buffer.toString('hex')
      });
      void this.protocolMessageStorage.save({
        receivedAt: new Date().toISOString(),
        direction: 'inbound',
        vehicleId: '',
        messageId: null,
        messageIdHex: null,
        serialNumber: 0,
        bodyLength: 0,
        isSubpackage: false,
        rawFrameHex: buffer.toString('hex'),
        bodyHex: '',
        bodyTextPreview: '',
        parseSuccess: false,
        parseError: 'parse_failed',
        parse: {}
      }).catch((error) => {
        console.error('Failed to persist raw parse-failed protocol message:', error);
      });
      if (this.shouldLogNoisy('jt808_parse_failed', 5000)) {
        console.warn('Failed to parse JT/T 808 message');
      }
      RawIngestLogger.write('jt808_parse_failed', {
        remoteAddress: socket.remoteAddress || null,
        remotePort: socket.remotePort || null,
        rawFrameHex: buffer.toString('hex')
      });
      return;
    }

    RawIngestLogger.write('jt808_message', {
      vehicleId: message.terminalPhone || null,
      messageId: Number(message.messageId || 0),
      messageIdHex: `0x${Number(message.messageId || 0).toString(16).padStart(4, '0')}`,
      serialNumber: Number(message.serialNumber || 0),
      bodyLength: Number(message.body?.length || 0),
      isSubpackage: !!message.isSubpackage,
      packetCount: message.packetCount || null,
      packetIndex: message.packetIndex || null,
      rawFrameHex: buffer.toString('hex'),
      bodyHex: (message.body || Buffer.alloc(0)).toString('hex'),
      bodyTextPreview: this.buildPayloadPreview(message.body || Buffer.alloc(0), 320)
    });
    

    //handle different messages
    switch (message.messageId) {
      case JTT808MessageType.TERMINAL_REGISTER:
        this.handleTerminalRegister(message, socket);
        break;
      case JTT808MessageType.TERMINAL_AUTH:
        this.handleTerminalAuth(message, socket);
        break;
      case JTT808MessageType.HEARTBEAT:
        this.handleHeartbeat(message, socket);
        break;
      case JTT808MessageType.LOCATION_REPORT:
        this.handleLocationReport(message, socket, buffer);
        break;
      case 0x0001:
        console.log(`Terminal general response from ${message.terminalPhone}:`);
        if (message.body.length >= 5) {
          const replySerial = message.body.readUInt16BE(0);
          const replyMsgId = message.body.readUInt16BE(2);
          const result = message.body.readUInt8(4);
          console.log(`   Reply to: 0x${replyMsgId.toString(16).padStart(4, '0')} (serial ${replySerial})`);
          console.log(`   Result: ${result === 0 ? 'Success' : result === 1 ? 'Failure' : result === 2 ? 'Message error' : 'Not supported'}`);
          
          if (replyMsgId === 0x9101) {
            console.log(`   Video stream request acknowledged - waiting for RTP data...`);
          } else if (replyMsgId === 0x9003) {
            console.log(`   Capabilities query acknowledged`);
          }
        }
        break;
      case 0x1003: // Audio/video capabilities response
        console.log(`📋 Capabilities response from ${message.terminalPhone}`);
        this.parseCapabilities(message.body, message.terminalPhone);
        break;
      case 0x1205: // Resource list response
        console.log(`📝 Resource list response (0x1205) from ${message.terminalPhone}`);

        if (message.isSubpackage && message.packetCount && message.packetIndex) {
          this.handleResourceListSubpackage(
            message.terminalPhone,
            message.body,
            message.packetCount,
            message.packetIndex
          );
        } else {
          const parsedResourceList = this.parseResourceList(message.terminalPhone, message.body);
          if (parsedResourceList) {
            this.emitResourceListAlerts(message.terminalPhone, parsedResourceList);
          }
          this.pushMessageTrace(message, buffer, {
            parser: 'resource-list-0x1205',
            parseSuccess: !!parsedResourceList,
            resourceList: parsedResourceList
          });
        }
        break;
      case 0x1206: // File upload completion notification
        console.log(`File upload completion (0x1206) from ${message.terminalPhone}`);
        if (message.body.length >= 3) {
          const responseSerial = message.body.readUInt16BE(0);
          const result = message.body.readUInt8(2);
          console.log(`   Response serial: ${responseSerial}`);
          console.log(`   Upload result: ${result === 0 ? 'success' : 'failure'}`);
        }
        break;
      case 0x0800: // Multimedia event message upload
        this.handleMultimediaEvent(message, socket);
        break;
      case 0x0801: // Multimedia data upload
        if (message.isSubpackage) {
          console.log(`📦 0x0801 subpackage ${message.packetIndex}/${message.packetCount} from ${message.terminalPhone}, body=${message.body.length}`);
        }
        await this.handleMultimediaData(message, socket);
        break;
      case 0x0704: // JT/T 808 location batch upload
        this.handleLocationBatchUpload(message, socket, buffer);
        break;
      case 0x0900: // JT/T 808 data uplink pass-through
        this.handleDataUplinkPassThrough(message, socket, buffer);
        break;
      default:
        this.handleUnknownMessage(message, socket, buffer);
    }

    // Intentionally no global vendor sweep: vendor alarms must come from deterministic protocol paths only.
  }

  private handleRTPData(buffer: Buffer, socket: net.Socket): void {
    const clientIp = socket.remoteAddress?.replace('::ffff:', '') || '';
    let vehicleId = this.ipToVehicle.get(clientIp) || clientIp;

    const parsedRtp = JTT1078RTPParser.parseRTPPacket(buffer);
    const parsedSim = String(parsedRtp?.header?.simCard || '').trim();
    if (parsedSim) {
      vehicleId = parsedSim;
      if (clientIp) {
        this.ipToVehicle.set(clientIp, parsedSim);
      }
    }
    
    if (this.rtpHandler) {
      this.rtpHandler(buffer, vehicleId);
    }
  }

  private handleTerminalRegister(message: any, socket: net.Socket): void {
    const ipAddress = socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
    this.deviceStorage.upsertDevice(message.terminalPhone, ipAddress);
    const registerInfo = this.parseTerminalRegisterInfo(
      message.body || Buffer.alloc(0),
      message.terminalPhone,
      ipAddress
    );
    if (registerInfo) {
      this.vehicleIdentityById.set(message.terminalPhone, registerInfo);
    }
    
    const vehicle: Vehicle = {
      id: message.terminalPhone,
      phone: message.terminalPhone,
      connected: true,
      lastHeartbeat: new Date(),
      activeStreams: new Set()
    };
    
    this.vehicles.set(message.terminalPhone, vehicle);
    this.connections.set(message.terminalPhone, socket);
    this.socketToVehicle.set(socket, message.terminalPhone);
    this.ipToVehicle.set(ipAddress, message.terminalPhone); // Map IP to vehicle
    
    console.log(`✅ Vehicle registered: ${message.terminalPhone} from ${ipAddress}`);
    
    // Send proper 0x8100 registration response with auth token
    const authToken = Buffer.from('AUTH123456', 'ascii');
    const responseBody = Buffer.alloc(3 + authToken.length);
    responseBody.writeUInt16BE(message.serialNumber, 0);
    responseBody.writeUInt8(0, 2); // Success
    authToken.copy(responseBody, 3);
    
    const response = this.buildMessage(0x8100, message.terminalPhone, this.getNextSerial(), responseBody);
    
    // Check if socket is writable before sending
    if (socket.writable) {
      socket.write(response);
      socket.setKeepAlive(true, 30000);
    }
    this.flushPendingCameraRequests(message.terminalPhone);
  }

  private parseTerminalRegisterInfo(body: Buffer, terminalPhone: string, ipAddress?: string): VehicleIdentity | null {
    // JT/T 808 0x0100 terminal register body:
    // province(2), city(2), manufacturer(5), model(20), terminalId(7), plateColor(1), plateNo(n)
    if (!body || body.length < 37) return null;
    try {
      const provinceId = body.readUInt16BE(0);
      const cityId = body.readUInt16BE(2);
      const manufacturerId = body.slice(4, 9).toString('ascii').replace(/\0/g, '').trim() || undefined;
      const terminalModel = this.decodeTerminalText(body.slice(9, 29)) || undefined;
      const terminalId = this.decodeTerminalText(body.slice(29, 36)) || undefined;
      const plateColor = body.readUInt8(36);
      const plateNumber = this.decodeTerminalText(body.slice(37)) || undefined;

      return {
        vehicleId: terminalPhone,
        terminalPhone,
        ipAddress,
        registeredAt: new Date().toISOString(),
        provinceId,
        cityId,
        manufacturerId,
        terminalModel,
        terminalId,
        plateColor,
        plateNumber
      };
    } catch {
      return null;
    }
  }

  private decodeTerminalText(raw: Buffer): string {
    if (!raw || raw.length === 0) return '';
    const utf8 = raw.toString('utf8').replace(/\0/g, '').trim();
    const latin = raw.toString('latin1').replace(/\0/g, '').trim();
    const picked = utf8.length >= latin.length ? utf8 : latin;
    return picked.replace(/[^\x20-\x7E\u00A0-\uFFFF]+/g, '').trim();
  }

  private getVehicleIdentity(vehicleId: string): VehicleIdentity {
    const cached = this.vehicleIdentityById.get(vehicleId);
    const vehicle = this.vehicles.get(vehicleId);
    return {
      vehicleId,
      terminalPhone: vehicle?.phone || cached?.terminalPhone || vehicleId,
      ipAddress: cached?.ipAddress,
      registeredAt: cached?.registeredAt,
      provinceId: cached?.provinceId,
      cityId: cached?.cityId,
      manufacturerId: cached?.manufacturerId,
      terminalModel: cached?.terminalModel,
      terminalId: cached?.terminalId,
      plateColor: cached?.plateColor,
      plateNumber: cached?.plateNumber
    };
  }

  private buildAlertContextMetadata(
    vehicleId: string,
    sourceMessageId: string,
    location?: { latitude: number; longitude: number }
  ): Record<string, unknown> {
    const identity = this.getVehicleIdentity(vehicleId);
    const last = this.lastKnownLocation.get(vehicleId);
    const selected = location || (last ? { latitude: last.latitude, longitude: last.longitude } : undefined);
    return {
      sourceMessageId,
      vehicle: identity,
      locationFix: selected
        ? {
            latitude: selected.latitude,
            longitude: selected.longitude,
            timestamp: (last?.timestamp || new Date()).toISOString()
          }
        : null
    };
  }

  private emitVendorMappedAlerts(
    vehicleId: string,
    mappedList: VendorMappedAlert[],
    options: {
      sourceMessageId: string;
      telemetryPrefix: string;
      timestamp?: Date;
      location?: { latitude: number; longitude: number };
      defaultChannel?: number;
      metadata?: Record<string, unknown>;
    }
  ): void {
    const baseTimestamp = options.timestamp || this.lastKnownLocation.get(vehicleId)?.timestamp || new Date();
    const baseLocation = options.location || (this.lastKnownLocation.get(vehicleId)
      ? {
          latitude: this.lastKnownLocation.get(vehicleId)!.latitude,
          longitude: this.lastKnownLocation.get(vehicleId)!.longitude
        }
      : undefined);

    for (const vendorMapped of mappedList) {
      if (!this.isVendorAlertEmittable(vendorMapped)) continue;
      this.bumpVendorTelemetry(
        'emittedBySourceCode',
        `${options.telemetryPrefix}:${vendorMapped.alarmCode ?? vendorMapped.signalCode}`
      );
      void this.alertManager.processExternalAlert({
        vehicleId,
        channel: vendorMapped.channel || options.defaultChannel || 1,
        type: vendorMapped.type,
        signalCode: vendorMapped.signalCode,
        priority: vendorMapped.priority,
        timestamp: baseTimestamp,
        location: baseLocation,
        metadata: {
          ...this.buildAlertContextMetadata(vehicleId, options.sourceMessageId, baseLocation),
          vendorCodeMapped: true,
          sourceType: vendorMapped.sourceType || 'global_payload',
          extractionMethod: vendorMapped.extractionMethod || null,
          confidence: vendorMapped.confidence || null,
          decoderVersion: this.vendorDecoderVersion,
          domain: vendorMapped.domain || null,
          alarmCode: vendorMapped.alarmCode ?? null,
          ...(options.metadata || {})
        }
      }).catch((error) => {
        console.error('Failed to process/forward vendor-mapped external alert:', error);
      });
    }
  }

  private buildMessage(messageId: number, phone: string, serial: number, body: Buffer): Buffer {
    const phoneBytes = this.stringToBcd(phone);
    const message = Buffer.alloc(13 + body.length);
    message.writeUInt16BE(messageId, 0);
    message.writeUInt16BE(body.length, 2);
    phoneBytes.copy(message, 4);
    message.writeUInt16BE(serial, 10);
    body.copy(message, 12);
    
    const checksum = this.calculateChecksum(message);
    message[12 + body.length] = checksum;
    
    const escaped = this.escape(message);
    const result = Buffer.alloc(escaped.length + 2);
    result[0] = 0x7E;
    escaped.copy(result, 1);
    result[result.length - 1] = 0x7E;
    
    return result;
  }

  private stringToBcd(str: string): Buffer {
    const padded = str.padStart(12, '0');
    return Buffer.from(padded, 'hex');
  }

  private escape(buffer: Buffer): Buffer {
    const result: number[] = [];
    for (const byte of buffer) {
      if (byte === 0x7E) {
        result.push(0x7D, 0x02);
      } else if (byte === 0x7D) {
        result.push(0x7D, 0x01);
      } else {
        result.push(byte);
      }
    }
    return Buffer.from(result);
  }

  private calculateChecksum(buffer: Buffer): number {
    let checksum = 0;
    for (const byte of buffer) {
      checksum ^= byte;
    }
    return checksum;
  }

  private handleTerminalAuth(message: any, socket: net.Socket): void {
    const ipAddress = socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
    
    // If vehicle doesn't exist, create it (camera skipped registration)
    if (!this.vehicles.has(message.terminalPhone)) {
      this.deviceStorage.upsertDevice(message.terminalPhone, ipAddress);
      
      const vehicle: Vehicle = {
        id: message.terminalPhone,
        phone: message.terminalPhone,
        connected: true,
        lastHeartbeat: new Date(),
        activeStreams: new Set()
      };
      this.vehicles.set(message.terminalPhone, vehicle);
      this.connections.set(message.terminalPhone, socket);
      this.socketToVehicle.set(socket, message.terminalPhone);
      this.ipToVehicle.set(ipAddress, message.terminalPhone); // Map IP to vehicle
      
      console.log(`✅ Camera authenticated: ${message.terminalPhone} from ${ipAddress}`);
      
      if (this.videoProcessingEnabled) {
        // Query capabilities only on servers that are allowed to manage video streams.
        setTimeout(() => {
          console.log(`🔍 Querying capabilities for ${message.terminalPhone}...`);
          this.queryCapabilities(message.terminalPhone);
        }, 1000);
      }

      const autoConfigureMask = String(process.env.AUTO_CONFIGURE_VIDEO_ALARM_MASK ?? 'true').toLowerCase() !== 'false';
      if (autoConfigureMask) {
        const configuredMask = Number(process.env.VIDEO_ALARM_MASK_WORD ?? 0) >>> 0;
        setTimeout(() => {
          const ok = this.setVideoAlarmMask(message.terminalPhone, configuredMask);
          if (ok) {
            console.log(`Set video alarm mask (0x007A)=0x${configuredMask.toString(16).padStart(8, '0')} for ${message.terminalPhone}`);
          }
        }, 1500);
      }
    }
    
    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    
    socket.write(response);
  }

  private handleHeartbeat(message: any, socket: net.Socket): void {
    const vehicle = this.vehicles.get(message.terminalPhone);
    if (vehicle) {
      vehicle.lastHeartbeat = new Date();
      vehicle.connected = true;
    }

    // Send heartbeat response
    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );

    socket.write(response);
    this.flushPendingCameraRequests(message.terminalPhone);
  }

  private handleLocationReport(message: any, socket: net.Socket, rawFrame?: Buffer): void {
    if (this.verboseLocationLogs) {
      console.log(`\n📍 Location Report from ${message.terminalPhone}`);
      console.log(`Body length: ${message.body.length} bytes`);
      console.log(`Body hex: ${message.body.toString('hex')}`);
    }

    // Parse basic location (first 28 bytes)
    if (message.body.length >= 28) {
      const alarmFlag = message.body.readUInt32BE(0);
      const statusFlag = message.body.readUInt32BE(4);
      const lat = message.body.readUInt32BE(8) / 1000000;
      const lon = message.body.readUInt32BE(12) / 1000000;
      if (this.verboseLocationLogs) {
        console.log(`Alarm flags: 0x${alarmFlag.toString(16).padStart(8, '0')}`);
        console.log(`Status flags: 0x${statusFlag.toString(16).padStart(8, '0')}`);
        console.log(`Location: ${lat}, ${lon}`);
      }

      // Parse additional info fields
      let offset = 28;
      if (this.verboseLocationLogs) {
        console.log(`\nAdditional Info Fields:`);
      }
      while (offset < message.body.length - 2) {
        const infoId = message.body.readUInt8(offset);
        const infoLength = message.body.readUInt8(offset + 1);

        if (offset + 2 + infoLength > message.body.length) break;

        const infoData = message.body.slice(offset + 2, offset + 2 + infoLength);
        if (this.verboseLocationLogs) {
          console.log(`  ID: 0x${infoId.toString(16).padStart(2, '0')} | Length: ${infoLength} | Data: ${infoData.toString('hex')}`);

          // Decode known alert fields
          if (infoId === 0x14) console.log(`    → Video Alarms`);
          if (infoId === 0x15) console.log(`    → Signal Loss Channels`);
          if (infoId === 0x16) console.log(`    → Signal Blocking Channels`);
          if (infoId === 0x17) console.log(`    → Memory Failures`);
          if (infoId === 0x18) console.log(`    → Abnormal Driving Behavior`);
          if (infoId === 0x64) console.log(`    → ADAS Extension (vendor/proprietary)`);
          if (infoId === 0x65) console.log(`    → DMS Extension (vendor/proprietary)`);
        }

        offset += 2 + infoLength;
      }

      if (this.verboseLocationLogs && offset === 28) {
        console.log(`  ⚠️  NO ADDITIONAL INFO FIELDS - Cameras not sending alert data`);
      }
    }
    
    // Parse location and alert data
    const alert = AlertParser.parseLocationReport(message.body, message.terminalPhone);
    const additionalInfo = this.extractLocationAdditionalInfoFields(message.body);
    
    if (alert) {
      (alert as any).rawAdditionalInfo = additionalInfo;
      this.lastKnownLocation.set(alert.vehicleId, {
        latitude: alert.latitude,
        longitude: alert.longitude,
        timestamp: alert.timestamp
      });

      // Always process protocol-native alarms first.
      this.processAlert(alert, '0x0200');

      // Also process any vendor-coded alarms found in additional info extensions.
      const vendorMappedList = this.detectVendorAlarmsFromLocationBody(message.body);
      this.emitVendorMappedAlerts(alert.vehicleId, vendorMappedList, {
        sourceMessageId: '0x0200',
        telemetryPrefix: 'location_extension',
        timestamp: alert.timestamp,
        location: { latitude: alert.latitude, longitude: alert.longitude },
        defaultChannel: this.inferLocationAlertChannel(alert),
        metadata: {
          rawPayloadHash: this.buildPayloadHash(message.body)
        }
      });

      const bodyVendorMapped = this.detectVendorAlarmsFromPayload(message.body, 'global_payload');
      this.emitVendorMappedAlerts(alert.vehicleId, bodyVendorMapped, {
        sourceMessageId: '0x0200',
        telemetryPrefix: 'global_payload',
        timestamp: alert.timestamp,
        location: { latitude: alert.latitude, longitude: alert.longitude },
        defaultChannel: this.inferLocationAlertChannel(alert),
        metadata: {
          rawPayloadHash: this.buildPayloadHash(message.body)
        }
      });
    }

    this.pushMessageTrace(message, rawFrame, {
      parser: 'location-report-0x0200',
      parseSuccess: !!alert,
      additionalInfo,
      parsedAlert: alert
        ? {
            timestamp: alert.timestamp?.toISOString?.() || null,
            latitude: alert.latitude,
            longitude: alert.longitude,
            speed: alert.speed,
            direction: alert.direction,
            altitude: alert.altitude,
            rawAlarmFlagHex: typeof alert.rawAlarmFlag === 'number'
              ? `0x${alert.rawAlarmFlag.toString(16).padStart(8, '0')}`
              : null,
            rawStatusFlagHex: typeof alert.rawStatusFlag === 'number'
              ? `0x${alert.rawStatusFlag.toString(16).padStart(8, '0')}`
              : null,
            baseAlarmSetBits: alert.alarmFlagSetBits || [],
            statusSetBits: alert.statusFlagSetBits || [],
            alarmFlags: alert.alarmFlags || null,
            statusFlags: alert.statusFlags || null,
            mileageKm: alert.mileageKm ?? null,
            fuelLiters: alert.fuelLiters ?? null,
            recordedSpeed: alert.recordedSpeed ?? null,
            extendedVehicleSignals: alert.extendedVehicleSignals || null,
            ioStatus: alert.ioStatus || null,
            wirelessSignalStrength: alert.wirelessSignalStrength ?? null,
            gnssSatelliteCount: alert.gnssSatelliteCount ?? null,
            vendorExtensions: alert.vendorExtensions || []
          }
        : null
    });
    
    // Send location report response
    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    
    socket.write(response);
    this.flushPendingCameraRequests(message.terminalPhone);
  }

  private handleLocationBatchUpload(message: any, socket: net.Socket, rawFrame?: Buffer): void {
    const body: Buffer = message.body;
    if (body.length < 3) {
      this.pushMessageTrace(message, rawFrame, {
        parser: 'location-batch-0x0704',
        parseSuccess: false,
        error: 'Body too short for batch upload'
      });
      const response = JTT1078Commands.buildGeneralResponse(
        message.terminalPhone,
        this.getNextSerial(),
        message.serialNumber,
        message.messageId,
        2 // message error
      );
      socket.write(response);
      return;
    }

    const declaredCount = body.readUInt16BE(0);
    const uploadType = body.readUInt8(2); // 0 normal, 1 blind-area补传 (terminal dependent)
    let offset = 3;
    let parsed = 0;
    let processedAlerts = 0;
    const itemDiagnostics: Array<Record<string, unknown>> = [];

    while (offset + 2 <= body.length) {
      const itemLen = body.readUInt16BE(offset);
      offset += 2;
      if (itemLen <= 0 || offset + itemLen > body.length) {
        break;
      }

      const itemBody = body.slice(offset, offset + itemLen);
      offset += itemLen;
      parsed++;

      const alert = AlertParser.parseLocationReport(itemBody, message.terminalPhone);
      const itemAdditionalInfo = this.extractLocationAdditionalInfoFields(itemBody);
      if (itemDiagnostics.length < 20) {
        itemDiagnostics.push({
          index: parsed,
          length: itemLen,
          parseSuccess: !!alert,
          bodyHex: itemBody.toString('hex').slice(0, 1024),
          additionalInfo: itemAdditionalInfo,
          parsedAlert: alert
            ? {
                timestamp: alert.timestamp?.toISOString?.() || null,
                latitude: alert.latitude,
                longitude: alert.longitude,
                speed: alert.speed,
                direction: alert.direction,
                altitude: alert.altitude,
                rawAlarmFlagHex: typeof alert.rawAlarmFlag === 'number'
                  ? `0x${alert.rawAlarmFlag.toString(16).padStart(8, '0')}`
                  : null,
                rawStatusFlagHex: typeof alert.rawStatusFlag === 'number'
                  ? `0x${alert.rawStatusFlag.toString(16).padStart(8, '0')}`
                  : null,
                baseAlarmSetBits: alert.alarmFlagSetBits || [],
                statusSetBits: alert.statusFlagSetBits || [],
                alarmFlags: alert.alarmFlags || null,
                statusFlags: alert.statusFlags || null,
                mileageKm: alert.mileageKm ?? null,
                fuelLiters: alert.fuelLiters ?? null,
                recordedSpeed: alert.recordedSpeed ?? null,
                extendedVehicleSignals: alert.extendedVehicleSignals || null,
                ioStatus: alert.ioStatus || null,
                wirelessSignalStrength: alert.wirelessSignalStrength ?? null,
                gnssSatelliteCount: alert.gnssSatelliteCount ?? null,
                vendorExtensions: alert.vendorExtensions || []
              }
            : null
        });
      }
      if (!alert) {
        continue;
      }
      (alert as any).rawAdditionalInfo = itemAdditionalInfo;

      this.lastKnownLocation.set(alert.vehicleId, {
        latitude: alert.latitude,
        longitude: alert.longitude,
        timestamp: alert.timestamp
      });

      const hadBefore = this.alertManager.getAlertStats().total;
      // Always process protocol-native alarms.
      this.processAlert(alert, '0x0704');

      // Also process vendor-coded alarms from extension payloads.
      const vendorMappedList = this.detectVendorAlarmsFromLocationBody(itemBody);
      this.emitVendorMappedAlerts(alert.vehicleId, vendorMappedList, {
        sourceMessageId: '0x0704',
        telemetryPrefix: 'location_extension',
        timestamp: alert.timestamp,
        location: { latitude: alert.latitude, longitude: alert.longitude },
        defaultChannel: this.inferLocationAlertChannel(alert),
        metadata: {
          rawPayloadHash: this.buildPayloadHash(itemBody)
        }
      });

      const bodyVendorMapped = this.detectVendorAlarmsFromPayload(itemBody, 'global_payload');
      this.emitVendorMappedAlerts(alert.vehicleId, bodyVendorMapped, {
        sourceMessageId: '0x0704',
        telemetryPrefix: 'global_payload',
        timestamp: alert.timestamp,
        location: { latitude: alert.latitude, longitude: alert.longitude },
        defaultChannel: this.inferLocationAlertChannel(alert),
        metadata: {
          rawPayloadHash: this.buildPayloadHash(itemBody)
        }
      });
      const hadAfter = this.alertManager.getAlertStats().total;
      if (hadAfter > hadBefore) {
        processedAlerts += hadAfter - hadBefore;
      }
    }

    console.log(`Location batch 0x0704 from ${message.terminalPhone}: declared=${declaredCount}, parsed=${parsed}, uploadType=${uploadType}, alerts=${processedAlerts}`);
    this.pushMessageTrace(message, rawFrame, {
      parser: 'location-batch-0x0704',
      parseSuccess: true,
      declaredCount,
      parsedItems: parsed,
      uploadType,
      processedAlerts,
      itemDiagnostics
    });

    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    socket.write(response);
  }

  private handleDataUplinkPassThrough(message: any, socket: net.Socket, rawFrame?: Buffer): void {
    const body: Buffer = message.body || Buffer.alloc(0);
    const passThroughType = body.length > 0 ? body.readUInt8(0) : -1;
    const payload = body.length > 1 ? body.slice(1) : Buffer.alloc(0);
    const decoded = this.decodeCustomPayloadText(payload) || '';
    const preview = this.buildPayloadPreview(payload, 320);
    const combinedText = `${decoded} ${preview}`.trim();
    const alarmParsingEnabled = this.isAlarmPassThroughType(passThroughType);
    const parsedList = this.extractPassThroughAlarms(
      passThroughType,
      payload,
      combinedText,
      alarmParsingEnabled,
      'pass_through'
    );
    const last = this.lastKnownLocation.get(message.terminalPhone);

    this.emitVendorMappedAlerts(message.terminalPhone, parsedList, {
      sourceMessageId: '0x0900',
      telemetryPrefix: 'pass_through',
      timestamp: last?.timestamp || new Date(),
      location: last ? { latitude: last.latitude, longitude: last.longitude } : undefined,
      defaultChannel: 1,
      metadata: {
        passThroughType,
        passThroughTypeHex: `0x${Math.max(passThroughType, 0).toString(16).padStart(2, '0')}`,
        decodedText: decoded || null,
        payloadPreview: preview,
        rawPayloadHash: this.buildPayloadHash(payload),
        rawPayloadHex: payload.toString('hex').slice(0, 1024)
      }
    });

    this.pushMessageTrace(message, rawFrame, {
      parser: 'data-uplink-pass-through-0x0900',
      passThroughType,
      passThroughTypeHex: `0x${Math.max(passThroughType, 0).toString(16).padStart(2, '0')}`,
      alarmParsingEnabled,
      payloadPreview: preview,
      decodedText: decoded || null,
      parsedAlerts: parsedList.map((parsed) => ({
        type: parsed.type,
        signalCode: parsed.signalCode,
        priority: parsed.priority,
        alarmCode: parsed.alarmCode ?? null,
        channel: parsed.channel || 1,
        extractionMethod: parsed.extractionMethod || null,
        confidence: parsed.confidence || null,
        sourceType: parsed.sourceType || 'pass_through'
      }))
    });

    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    socket.write(response);
  }

  private handleUnknownMessage(message: any, socket: net.Socket, rawFrame?: Buffer): void {
    const last = this.lastKnownLocation.get(message.terminalPhone);
    const body = message.body || Buffer.alloc(0);
    const mappedAlerts = this.detectVendorAlarmsFromPayload(body, 'global_payload');
    this.emitVendorMappedAlerts(message.terminalPhone, mappedAlerts, {
      sourceMessageId: `0x${Number(message.messageId || 0).toString(16).padStart(4, '0')}`,
      telemetryPrefix: 'unknown_message',
      timestamp: last?.timestamp || new Date(),
      location: last ? { latitude: last.latitude, longitude: last.longitude } : undefined,
      defaultChannel: 1,
      metadata: {
        rawPayloadHash: this.buildPayloadHash(body),
        rawPayloadHex: body.toString('hex').slice(0, 1024)
      }
    });
    this.pushMessageTrace(message, rawFrame, {
      parser: 'unknown-message',
      parsedAlerts: mappedAlerts.map((parsed) => ({
        type: parsed.type,
        signalCode: parsed.signalCode,
        priority: parsed.priority,
        alarmCode: parsed.alarmCode ?? null,
        channel: parsed.channel || 1,
        extractionMethod: parsed.extractionMethod || null,
        confidence: parsed.confidence || null,
        sourceType: parsed.sourceType || 'global_payload'
      }))
    });

    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    socket.write(response);
  }

  private isAlarmPassThroughType(passThroughType: number): boolean {
    if (!Number.isFinite(passThroughType) || passThroughType < 0 || passThroughType > 0xFF) {
      return false;
    }
    // JT/T 808 8.62 / Table 93 documented pass-through types.
    // Keep vendor-observed compact type 0xA1 explicitly enabled as a deterministic path.
    if (passThroughType === 0x41 || passThroughType === 0x42) return true;
    if (passThroughType >= 0xF0 && passThroughType <= 0xFF) return true;
    if (passThroughType === 0xA1) return true;
    return false;
  }

  private extractPassThroughAlarms(
    passThroughType: number,
    payload: Buffer,
    text: string,
    allowHeuristicBinaryDecode: boolean,
    sourceType: VendorMappedAlert['sourceType']
  ): VendorMappedAlert[] {
    const channelMatch = text.match(/\bch(?:annel)?\s*[:#-]?\s*(\d{1,2})\b/i);
    const channel = channelMatch ? Number(channelMatch[1]) : undefined;
    const strictMode = this.isStrictAlertMode();
    const canAttemptDecode = allowHeuristicBinaryDecode || !strictMode;
    if (!canAttemptDecode) {
      this.bumpVendorTelemetry('suppressedByReason', `pass_through_type_not_whitelisted_${passThroughType}`);
      return [];
    }
    const results: VendorMappedAlert[] = [];
    const seen = new Set<string>();
    const add = (item: VendorMappedAlert | null) => {
      if (!item) return;
      const key = `${item.signalCode}|${item.alarmCode ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ ...item, sourceType });
    };

    const textCode = this.extractVendorAlarmCodeFromText(text);
    if (textCode !== null) {
      const mapped = this.mapVendorAlarmCode(textCode, { allowPlatformVideoCodes: true });
      if (mapped) {
        add({
          ...mapped,
          channel,
          alarmCode: textCode,
          extractionMethod: 'text_numeric',
          confidence: strictMode ? 'medium' : 'high'
        });
      }
    }

    const textMapped = !strictMode ? this.mapVendorAlertText(text) : null;
    if (textMapped) {
      add({
        ...textMapped,
        channel: textMapped.channel || channel,
        extractionMethod: 'text_label',
        confidence: strictMode ? 'medium' : 'high'
      });
    }

    // Vendor-observed compact video alarm payload on pass-through type 0xA1:
    // byte0 = subtype (0x01..0x07) mapping to JT/T 1078 Table 38 0x0101..0x0107.
    // This is deterministic (numeric code based), not keyword inference.
    const compactA1 = this.decodeCompactA1VideoAlarm(passThroughType, payload);
    if (compactA1) {
      add({
        ...compactA1,
        channel: compactA1.channel || channel
      });
    }

    // No free-text fallback for vendor alarms.

    // Binary decode is only attempted for pass-through types aligned to alarm payloads.
    if (!canAttemptDecode) {
      if (strictMode && results.length === 0) {
        this.bumpVendorTelemetry('suppressedByReason', 'strict_no_deterministic_code');
      }
      return results;
    }

    // Decode Appendix-A framed peripheral payloads first.
    const framed = this.decodePeripheralProtocolFrames(payload);
    for (const frame of framed) {
      if (strictMode && !frame.validChecksum) {
        this.bumpVendorTelemetry('suppressedByReason', 'invalid_peripheral_checksum');
        continue;
      }
      const mappedList = this.mapVendorAlarmsFromBytes(frame.userData, true, {
        strictMode,
        extractionMethod: 'framed_peripheral',
        requireDeterministic: true
      });
      for (const mapped of mappedList) add(mapped);
    }

    // No generic first-word fallback in pass-through path.

    return results;
  }

  private decodeCompactA1VideoAlarm(
    passThroughType: number,
    payload: Buffer
  ): VendorMappedAlert | null {
    if (passThroughType !== 0xA1) return null;
    if (!payload || payload.length < 1) return null;

    const subtype = payload.readUInt8(0);
    if (subtype < 0x01 || subtype > 0x07) return null;

    const alarmCode = 0x0100 + subtype;
    const mapped = this.mapVendorAlarmCode(alarmCode, { allowPlatformVideoCodes: true });
    if (!mapped) return null;

    // Some devices place logical channel in byte1.
    const maybeChannel = payload.length >= 2 ? payload.readUInt8(1) : 0;
    const channel = maybeChannel >= 1 && maybeChannel <= 32 ? maybeChannel : undefined;

    return {
      ...mapped,
      channel,
      alarmCode,
      extractionMethod: 'numeric_be',
      confidence: 'high'
    };
  }

  private inferLocationAlertChannel(alert: LocationAlert): number {
    if (alert.signalLossChannels && alert.signalLossChannels.length > 0) {
      return alert.signalLossChannels[0];
    }
    if (alert.blockingChannels && alert.blockingChannels.length > 0) {
      return alert.blockingChannels[0];
    }
    return 1;
  }

  private resolveAlertCaptureChannels(vehicleId: string, requestedChannel?: number): number[] {
    const vehicle = this.vehicles.get(vehicleId);
    const channelsFromCapabilities = vehicle?.channels
      ?.filter((ch) => ch.type === 'video' || ch.type === 'audio_video')
      .map((ch) => Number(ch.logicalChannel))
      .filter((ch) => Number.isFinite(ch) && ch > 0);
    const channelsFromActiveStreams = Array.from(vehicle?.activeStreams || [])
      .map((ch) => Number(ch))
      .filter((ch) => Number.isFinite(ch) && ch > 0);
    const requested = Number(requestedChannel);
    const channels = [
      ...(channelsFromCapabilities || []),
      ...channelsFromActiveStreams,
      ...(Number.isFinite(requested) && requested > 0 ? [requested] : [])
    ];

    if (channels && channels.length > 0) {
      return Array.from(new Set(channels)).sort((a, b) => a - b);
    }

    const fallback = Number(requestedChannel);
    const defaults = [
      ...(Number.isFinite(fallback) && fallback > 0 ? [fallback] : []),
      1,
      2
    ];
    return Array.from(new Set(defaults)).sort((a, b) => a - b);
  }

  private detectVendorAlarmsFromLocationBody(
    body: Buffer
  ): Array<VendorMappedAlert & { infoId?: number }> {
    if (!body || body.length <= 28) return [];
    const results: Array<VendorMappedAlert & { infoId?: number }> = [];
    const seen = new Set<string>();
    const add = (item: (VendorMappedAlert & { infoId?: number }) | null) => {
      if (!item) return;
      const key = `${item.signalCode}|${item.alarmCode ?? ''}|${item.channel ?? ''}|${item.infoId ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(item);
    };

    let offset = 28;
    while (offset + 2 <= body.length) {
      const infoId = body.readUInt8(offset);
      const infoLength = body.readUInt8(offset + 1);
      if (offset + 2 + infoLength > body.length) break;

      const infoData = body.slice(offset + 2, offset + 2 + infoLength);
      const mappedList = this.detectVendorAlarmsFromPayload(infoData, 'location_extension');
      for (const mapped of mappedList) {
        add({ ...mapped, infoId });
      }
      offset += 2 + infoLength;
    }
    return results;
  }

  private detectVendorAlarmsFromPayload(
    payload: Buffer,
    sourceType: VendorMappedAlert['sourceType']
  ): VendorMappedAlert[] {
    if (!payload || payload.length === 0) return [];
    const strictMode = this.isStrictAlertMode();
    const results: VendorMappedAlert[] = [];
    const seen = new Set<string>();
    const add = (item: VendorMappedAlert | null) => {
      if (!item) return;
      const key = `${item.signalCode}|${item.alarmCode ?? ''}|${item.channel ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ ...item, sourceType });
    };

    // JT/T 808 Appendix A peripheral frames are commonly embedded in pass-through payloads.
    // Decode framed content first and inspect user-data for known alarm codes/text.
    const peripheralFrames = this.decodePeripheralProtocolFrames(payload);
    for (const frame of peripheralFrames) {
      if (strictMode && !frame.validChecksum) {
        this.bumpVendorTelemetry('suppressedByReason', 'invalid_peripheral_checksum');
        continue;
      }
      if (strictMode) {
        // Appendix-A strictness:
        // - user-defined peripheral type: 0xF0-0xFF
        // - proprietary command types: 0x44-0xFF
        const userDefinedPeripheral = frame.peripheralType >= 0xF0 && frame.peripheralType <= 0xFF;
        const proprietaryCommand = frame.commandType >= 0x44 && frame.commandType <= 0xFF;
        if (!userDefinedPeripheral || !proprietaryCommand) {
          this.bumpVendorTelemetry('suppressedByReason', 'strict_peripheral_type_or_command_not_vendor');
          continue;
        }
      }
      const mappedList = this.mapVendorAlarmsFromBytes(frame.userData, false, {
        strictMode,
        extractionMethod: 'framed_peripheral',
        requireDeterministic: true
      });
      for (const mapped of mappedList) add(mapped);
    }

    // Restore the broader historical behavior: also scan the raw payload itself.
    // This lets vendor codes surface even when the device does not wrap them in an
    // Appendix-A peripheral frame but still sends deterministic numeric/text payloads.
    const rawMappedList = this.mapVendorAlarmsFromBytes(payload, true, {
      strictMode,
      extractionMethod: 'ascii_code',
      requireDeterministic: false
    });
    for (const mapped of rawMappedList) add(mapped);

    if (results.length === 0) {
      this.bumpVendorTelemetry('suppressedByReason', 'no_deterministic_vendor_pattern_detected');
    }

    return results;
  }

  private mapVendorAlarmsFromBytes(
    payload: Buffer,
    allowPlatformVideoCodes: boolean,
    options?: {
      strictMode?: boolean;
      extractionMethod?: VendorExtractionMethod;
      requireDeterministic?: boolean;
    }
  ): VendorMappedAlert[] {
    if (!payload || payload.length === 0) return [];
    const strictMode = options?.strictMode ?? this.isStrictAlertMode();
    const extractionMethod = options?.extractionMethod || 'framed_peripheral';
    const requireDeterministic = options?.requireDeterministic ?? true;
    const results: VendorMappedAlert[] = [];
    const seen = new Set<string>();
    const add = (item: VendorMappedAlert | null) => {
      if (!item) return;
      const key = `${item.signalCode}|${item.alarmCode ?? ''}|${item.channel ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(item);
    };

    const decoded = this.decodeCustomPayloadText(payload) || '';
    const preview = this.buildPayloadPreview(payload, 320);
    const combined = `${decoded} ${preview}`.trim();
    const channelMatch = combined.match(/\bch(?:annel)?\s*[:#-]?\s*(\d{1,2})\b/i);
    const channel = channelMatch ? Number(channelMatch[1]) : undefined;

    const mergedCodes = new Set<number>();
    const strictCodes = this.extractStrictDeterministicVendorCodes(payload);
    for (const c of strictCodes) mergedCodes.add(c);

    const textCode = this.extractVendorAlarmCodeFromText(combined);
    if (textCode !== null) mergedCodes.add(textCode);

    for (const code of mergedCodes) {
      const mapped = this.mapVendorAlarmCode(code, { allowPlatformVideoCodes });
      if (mapped) {
        add({
          ...mapped,
          channel,
          alarmCode: code,
          extractionMethod,
          confidence: 'high'
        });
      }
    }

    const textMapped = !strictMode ? this.mapVendorAlertText(combined) : null;
    if (textMapped) {
      add({
        ...textMapped,
        channel: textMapped.channel || channel,
        extractionMethod: extractionMethod === 'framed_peripheral' ? 'text_label' : extractionMethod,
        confidence: strictMode ? 'medium' : 'high'
      });
    }

    if (requireDeterministic && results.length === 0) {
      this.bumpVendorTelemetry('parseFailuresByReason', 'no_mapped_vendor_codes');
    }

    return results;
  }

  private extractVendorAlarmCodeFromText(text: string): number | null {
    if (!text) return null;
    const hexMatch = text.match(/\b0x([0-9a-f]{4})\b/i);
    if (hexMatch) return parseInt(hexMatch[1], 16);
    const match = text.match(/\b(1000[1-8]|10016|10017|1010[1-7]|10116|10117|1120[1-3])\b/);
    return match ? Number(match[1]) : null;
  }

  private mapVendorAlertText(
    text: string
  ): ({ type: string; priority: AlertPriority; signalCode: string; channel?: number } & Partial<VendorMappedAlert>) | null {
    if (!text) return null;
    const patterns: Array<{ re: RegExp; type: string; priority: AlertPriority; signalCode: string }> = [
      { re: /\bfatigue\s+driving\s+alarm\b/i, type: 'DMS: Fatigue driving alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10101_fatigue_driving_alarm' },
      { re: /\bhandheld\s+phone\s+alarm\b/i, type: 'DMS: Handheld phone alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10102_handheld_phone_alarm' },
      { re: /\bsmoking\s+alarm\b/i, type: 'DMS: Smoking alarm', priority: AlertPriority.HIGH, signalCode: 'dms_10103_smoking_alarm' },
      { re: /\bforward\s+collision\s+warning\b/i, type: 'ADAS: Forward collision warning', priority: AlertPriority.CRITICAL, signalCode: 'adas_10001_forward_collision_warning' },
      { re: /\blane\s+departure\s+alarm\b/i, type: 'ADAS: Lane departure alarm', priority: AlertPriority.HIGH, signalCode: 'adas_10002_lane_departure_alarm' },
      { re: /\bfollowing\s+distance\s+too\s+close\b/i, type: 'ADAS: Following distance too close', priority: AlertPriority.HIGH, signalCode: 'adas_10003_following_distance_too_close' },
      { re: /\bpedestrian\s+collision\s+alarm\b/i, type: 'ADAS: Pedestrian collision alarm', priority: AlertPriority.CRITICAL, signalCode: 'adas_10004_pedestrian_collision_alarm' },
      { re: /\bfrequent\s+lane\s+change\s+alarm\b/i, type: 'ADAS: Frequent lane change alarm', priority: AlertPriority.HIGH, signalCode: 'adas_10005_frequent_lane_change_alarm' },
      { re: /\broad\s+sign\s+over-?limit\s+alarm\b/i, type: 'ADAS: Road sign over-limit alarm', priority: AlertPriority.MEDIUM, signalCode: 'adas_10006_road_sign_over_limit_alarm' },
      { re: /\bobstruction\s+alarm\b/i, type: 'ADAS: Obstruction alarm', priority: AlertPriority.MEDIUM, signalCode: 'adas_10007_obstruction_alarm' },
      { re: /\bdriver\s+assistance\s+function\s+failure(?:\s+alarm)?\b/i, type: 'ADAS: Driver assistance function failure alarm', priority: AlertPriority.MEDIUM, signalCode: 'adas_10008_driver_assist_function_failure' },
      { re: /\broad\s+sign\s+identification\s+event\b/i, type: 'ADAS: Road sign identification event', priority: AlertPriority.LOW, signalCode: 'adas_10016_road_sign_identification_event' },
      { re: /\bactive\s+capture\s+event\b/i, type: 'ADAS: Active capture event', priority: AlertPriority.LOW, signalCode: 'adas_10017_active_capture_event' },
      { re: /\bforward\s+camera\s+invisible\s+too\s+long\b/i, type: 'DMS: Forward camera invisible too long', priority: AlertPriority.HIGH, signalCode: 'dms_10104_forward_invisible_too_long' },
      { re: /\bdriver\s+alarm\s+not\s+detected\b/i, type: 'DMS: Driver alarm not detected', priority: AlertPriority.MEDIUM, signalCode: 'dms_10105_driver_alarm_not_detected' },
      { re: /\bboth\s+hands\s+off\s+steering\s+wheel\b/i, type: 'DMS: Both hands off steering wheel', priority: AlertPriority.HIGH, signalCode: 'dms_10106_hands_off_steering' },
      { re: /\bdriver\s+behavior\s+monitoring\s+failure\b/i, type: 'DMS: Driver behavior monitoring failure', priority: AlertPriority.MEDIUM, signalCode: 'dms_10107_behavior_monitoring_failure' },
      { re: /\bautomatic\s+capture\s+event\b/i, type: 'DMS: Automatic capture event', priority: AlertPriority.LOW, signalCode: 'dms_10116_automatic_capture_event' },
      { re: /\bdriver\s+change\b/i, type: 'DMS: Driver change', priority: AlertPriority.LOW, signalCode: 'dms_10117_driver_change' }
    ];
    const hit = patterns.find((p) => p.re.test(text));
    if (!hit) return null;
    const channelMatch = text.match(/\bch(?:annel)?\s*[:#-]?\s*(\d{1,2})\b/i);
    const channel = channelMatch ? Number(channelMatch[1]) : undefined;
    return {
      type: hit.type,
      priority: hit.priority,
      signalCode: hit.signalCode,
      channel
    };
  }

  private isVendorAlarmLocationInfoId(infoId: number): boolean {
    // Deterministic, env-independent vendor extension matching.
    // JT/T 808 custom additional info IDs are in 0xE1~0xFF.
    return Number.isFinite(infoId) && infoId >= 0xE1 && infoId <= 0xFF;
  }

  private decodePeripheralProtocolFrames(payload: Buffer): Array<{
    validChecksum: boolean;
    version: number;
    vendor: number;
    peripheralType: number;
    commandType: number;
    userData: Buffer;
  }> {
    const frames: Buffer[] = [];
    const marker = 0x7e;

    let start = -1;
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] !== marker) continue;
      if (start >= 0 && i > start + 1) {
        frames.push(payload.slice(start + 1, i));
      }
      start = i;
    }

    // Some terminals strip 0x7e markers before pass-through; treat entire payload as one candidate too.
    if (frames.length === 0 && payload.length >= 6) {
      frames.push(payload);
    }

    const decoded: Array<{
      validChecksum: boolean;
      version: number;
      vendor: number;
      peripheralType: number;
      commandType: number;
      userData: Buffer;
    }> = [];

    for (const frame of frames) {
      const unescaped = this.unescapePeripheralFrame(frame);
      if (unescaped.length < 6) continue;

      const parsedCandidates: Array<{
        validChecksum: boolean;
        version: number;
        vendor: number;
        peripheralType: number;
        commandType: number;
        userData: Buffer;
      }> = [];

      // Layout A: check(1) + version(1) + vendor(2) + peripheral(1) + command(1) + user
      if (unescaped.length >= 6) {
        const checkCode = unescaped.readUInt8(0);
        const version = unescaped.readUInt8(1);
        const vendor = unescaped.readUInt16BE(2);
        const peripheralType = unescaped.readUInt8(4);
        const commandType = unescaped.readUInt8(5);
        const userData = unescaped.slice(6);
        let sum = 0;
        for (let i = 2; i < unescaped.length; i++) {
          sum = (sum + unescaped[i]) & 0xff;
        }
        parsedCandidates.push({
          validChecksum: sum === checkCode,
          version,
          vendor,
          peripheralType,
          commandType,
          userData
        });
      }

      // Layout B fallback: check(1) + version(2) + vendor(2) + peripheral(1) + command(1) + user
      if (unescaped.length >= 7) {
        const checkCode = unescaped.readUInt8(0);
        const version = unescaped.readUInt16BE(1);
        const vendor = unescaped.readUInt16BE(3);
        const peripheralType = unescaped.readUInt8(5);
        const commandType = unescaped.readUInt8(6);
        const userData = unescaped.slice(7);
        let sum = 0;
        for (let i = 3; i < unescaped.length; i++) {
          sum = (sum + unescaped[i]) & 0xff;
        }
        parsedCandidates.push({
          validChecksum: sum === checkCode,
          version,
          vendor,
          peripheralType,
          commandType,
          userData
        });
      }

      const chosen = parsedCandidates.find((c) => c.validChecksum) || parsedCandidates[0];
      if (chosen) decoded.push(chosen);
    }

    return decoded;
  }

  private unescapePeripheralFrame(frame: Buffer): Buffer {
    const out: number[] = [];
    for (let i = 0; i < frame.length; i++) {
      const b = frame[i];
      if (b === 0x7d && i + 1 < frame.length) {
        const n = frame[i + 1];
        if (n === 0x02) {
          out.push(0x7e);
          i++;
          continue;
        }
        if (n === 0x01) {
          out.push(0x7d);
          i++;
          continue;
        }
      }
      out.push(b);
    }
    return Buffer.from(out);
  }

  private extractStrictDeterministicVendorCodes(payload: Buffer): number[] {
    if (!payload || payload.length === 0) return [];
    const known = getKnownVendorCodes();
    const result = new Set<number>();

    // Strict mode only accepts deterministic leading-field candidates.
    if (payload.length >= 2) {
      const firstBe = payload.readUInt16BE(0);
      const firstLe = payload.readUInt16LE(0);
      if (known.has(firstBe)) result.add(firstBe);
      if (known.has(firstLe)) result.add(firstLe);
    }
    if (payload.length >= 4) {
      const firstBe32 = payload.readUInt32BE(0);
      const firstLe32 = payload.readUInt32LE(0);
      if (known.has(firstBe32)) result.add(firstBe32);
      if (known.has(firstLe32)) result.add(firstLe32);
    }

    return Array.from(result.values());
  }

  private mapVendorAlarmCode(
    code: number,
    options: { allowPlatformVideoCodes?: boolean } = {}
  ): { type: string; priority: AlertPriority; signalCode: string; domain?: string } | null {
    const entry = getVendorAlarmByCode(code, options);
    if (!entry) return null;
    return {
      type: entry.type,
      priority: entry.defaultPriority as AlertPriority,
      signalCode: entry.signalCode,
      domain: entry.domain
    };
  }

  private processAlert(alert: LocationAlert, sourceMessageId: string = '0x0200'): void {
    const enriched = alert as LocationAlert & Record<string, unknown>;
    enriched.sourceMessageId = sourceMessageId;
    enriched.vehicle = this.getVehicleIdentity(alert.vehicleId);
    enriched.locationFix = {
      latitude: alert.latitude,
      longitude: alert.longitude,
      timestamp: alert.timestamp?.toISOString?.() || new Date().toISOString()
    };

    // Check if there are any actual alerts
    const hasKnownBaseAlarmFlags = !!(alert.alarmFlags && (
      alert.alarmFlags.emergency ||
      alert.alarmFlags.overspeed ||
      alert.alarmFlags.fatigue ||
      alert.alarmFlags.dangerousDriving ||
      alert.alarmFlags.gnssModuleFailure ||
      alert.alarmFlags.gnssAntennaDisconnected ||
      alert.alarmFlags.gnssAntennaShortCircuit ||
      alert.alarmFlags.terminalPowerUndervoltage ||
      alert.alarmFlags.terminalPowerFailure ||
      alert.alarmFlags.terminalDisplayFailure ||
      alert.alarmFlags.ttsModuleFailure ||
      alert.alarmFlags.cameraFailure ||
      alert.alarmFlags.transportIcCardModuleFailure ||
      alert.alarmFlags.overspeedWarning ||
      alert.alarmFlags.fatigueWarning ||
      alert.alarmFlags.vibrationAlarm ||
      alert.alarmFlags.lightAlarm ||
      alert.alarmFlags.magneticInductiveAlarm ||
      alert.alarmFlags.accumulatedDrivingTimeAlarm ||
      alert.alarmFlags.overtimeParking ||
      alert.alarmFlags.areaEntryExitAlarm ||
      alert.alarmFlags.routeEntryExitAlarm ||
      alert.alarmFlags.routeTravelTimeAlarm ||
      alert.alarmFlags.routeDeviationAlarm ||
      alert.alarmFlags.vssFailure ||
      alert.alarmFlags.abnormalFuelCapacity ||
      alert.alarmFlags.vehicleTheft ||
      alert.alarmFlags.illegalIgnition ||
      alert.alarmFlags.illegalDisplacement ||
      alert.alarmFlags.collisionWarning ||
      alert.alarmFlags.rolloverWarning ||
      alert.alarmFlags.illegalDoorOpenAlarm
    ));
    const hasAnyBaseAlarmBit = (alert.alarmFlagSetBits?.length || 0) > 0;
    const hasBaseAlarmFlags = hasKnownBaseAlarmFlags || hasAnyBaseAlarmBit;
    const hasKnownVideoAlarms = !!(alert.videoAlarms && Object.values(alert.videoAlarms).some(v => v === true));
    const hasAnyVideoAlarmBit = (alert.videoAlarms?.setBits?.length || 0) > 0;
    const hasVideoAlarms = hasKnownVideoAlarms || hasAnyVideoAlarmBit;
    const hasDrivingBehavior = alert.drivingBehavior && (alert.drivingBehavior.fatigue || alert.drivingBehavior.phoneCall || alert.drivingBehavior.smoking || alert.drivingBehavior.custom > 0);
    const hasSignalLoss = alert.signalLossChannels && alert.signalLossChannels.length > 0;
    const hasBlocking = alert.blockingChannels && alert.blockingChannels.length > 0;
    const hasMemoryFailures = alert.memoryFailures && (alert.memoryFailures.main.length > 0 || alert.memoryFailures.backup.length > 0);
    
    const hasAnyAlert =
      hasBaseAlarmFlags ||
      hasVideoAlarms ||
      !!hasDrivingBehavior ||
      !!hasSignalLoss ||
      !!hasBlocking ||
      !!hasMemoryFailures;

    // Always forward to AlertManager so it can clear edge-trigger state when alarms drop.
    // Only skip verbose logging for "no-alert" packets.
    if (!hasAnyAlert) {
      void this.alertManager.processAlert(enriched as LocationAlert).catch((error) => {
        console.error('Failed to process/forward no-alert state packet:', error);
      });
      return;
    }
    
    console.log('\n' + '='.repeat(80));
    console.log(`🚨🚨🚨 ALERT DETECTED 🚨🚨🚨`);
    console.log(`Vehicle: ${alert.vehicleId} | Time: ${alert.timestamp.toISOString()}`);
    console.log(`Location: ${alert.latitude}, ${alert.longitude}`);
    console.log('='.repeat(80));

    if (hasBaseAlarmFlags) {
      console.log('\n🚦 BASE ALARM FLAGS (0x0200 DWORD):', alert.alarmFlags);
    }
    
    if (hasVideoAlarms) {
      console.log('\n📹 VIDEO ALARMS:', alert.videoAlarms);
    }
    
    if (hasDrivingBehavior) {
      console.log('\n🚨 ABNORMAL DRIVING BEHAVIOR:');
      const behavior = alert.drivingBehavior!;
      
      if (behavior.fatigue) {
        console.log(`  😴 FATIGUE - Level: ${behavior.fatigueLevel}/100 ${behavior.fatigueLevel > 70 ? '⚠️ CRITICAL' : ''}`);
      }
      if (behavior.phoneCall) {
        console.log(`  📱 PHONE CALL DETECTED`);
      }
      if (behavior.smoking) {
        console.log(`  🚬 SMOKING DETECTED`);
      }
      if (behavior.custom > 0) {
        console.log(`  ⚠️  CUSTOM: ${behavior.custom}`);
      }
    }
    
    if (hasSignalLoss) {
      console.log(`\n📺 SIGNAL LOSS - Channels: ${alert.signalLossChannels!.join(', ')}`);
    }
    
    if (hasBlocking) {
      console.log(`🚫 SIGNAL BLOCKING - Channels: ${alert.blockingChannels!.join(', ')}`);
    }
    
    if (hasMemoryFailures) {
      if (alert.memoryFailures!.main.length) {
        console.log(`\n💾 MAIN MEMORY FAILURES: ${alert.memoryFailures!.main.join(', ')}`);
      }
      if (alert.memoryFailures!.backup.length) {
        console.log(`💾 BACKUP MEMORY FAILURES: ${alert.memoryFailures!.backup.join(', ')}`);
      }
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
    
    // Don't save LocationAlert to database - it's converted to AlertEvent by AlertManager
    // this.alertStorage.saveAlert(alert);
    
    // Process through alert manager for escalation and screenshot capture
    void this.alertManager.processAlert(enriched as LocationAlert).catch((error) => {
      console.error('Failed to process/forward alert packet:', error);
    });
  }

  private handleDisconnection(socket: net.Socket): void {
    const vehicleId = this.socketToVehicle.get(socket);
    if (vehicleId) {
      const vehicle = this.vehicles.get(vehicleId);
      if (vehicle) {
        vehicle.connected = false;
        vehicle.activeStreams.clear();
      }
      this.connections.delete(vehicleId);
      this.socketToVehicle.delete(socket);
    }
  }

  private parseCapabilities(body: Buffer, vehiclePhone: string): void {
    if (body.length < 10) {
      console.log(`⚠️ Capabilities body too short: ${body.length} bytes`);
      return;
    }
    
    // Parse according to Table 11 in spec
    const inputAudioEncoding = body.readUInt8(0);
    const inputAudioChannels = body.readUInt8(1);
    const inputAudioSampleRate = body.readUInt8(2);
    const inputAudioSampleBits = body.readUInt8(3);
    const audioFrameLength = body.readUInt16BE(4);
    const supportsAudioOutput = body.readUInt8(6) === 1;
    const videoEncoding = body.readUInt8(7);
    const maxAudioChannels = body.readUInt8(8);
    const maxVideoChannels = body.readUInt8(9);
    
    console.log(`
📊 Camera Capabilities for ${vehiclePhone}:`);
    console.log(`   Audio: encoding=${inputAudioEncoding}, channels=${inputAudioChannels}, rate=${inputAudioSampleRate}`);
    console.log(`   Video: encoding=${videoEncoding}, max channels=${maxVideoChannels}`);
    console.log(`   Max audio channels: ${maxAudioChannels}`);
    console.log(`   Max video channels: ${maxVideoChannels}`);
    
    const vehicle = this.vehicles.get(vehiclePhone);
    if (!vehicle) {
      console.log(`⚠️ Vehicle ${vehiclePhone} not found`);
      return;
    }
    
    // Create channel list based on max video channels
    const channels: VehicleChannel[] = [];
    for (let i = 1; i <= maxVideoChannels; i++) {
      channels.push({
        physicalChannel: i,
        logicalChannel: i,
        type: 'video',
        hasGimbal: false
      });
    }
    
    vehicle.channels = channels;
    console.log(`✅ Discovered ${channels.length} video channels`);
    
    if (!this.videoProcessingEnabled) {
      console.log(`⏭️ Skipping auto-start of video streams for ${vehiclePhone} because VIDEO_PROCESSING_ENABLED=false`);
      return;
    }

    // Auto-start video streaming on all channels to ensure circular buffer is always filled
    console.log(`\n🎬 Auto-starting video streams on all channels for alert capture...`);
    for (const channel of channels) {
      setTimeout(() => {
        console.log(`▶️ Starting stream on channel ${channel.logicalChannel}`);
        this.startVideo(vehiclePhone, channel.logicalChannel);
      }, 250 * channel.logicalChannel); // Stagger by 250ms (faster startup)
    }
  }
  private handleResourceListSubpackage(
    vehicleId: string,
    bodyPart: Buffer,
    packetCount: number,
    packetIndex: number
  ): void {
    const key = vehicleId;
    const now = Date.now();
    const maxAgeMs = 30000;

    for (const [k, pending] of this.pendingResourceLists.entries()) {
      if (now - pending.createdAt > maxAgeMs) {
        this.pendingResourceLists.delete(k);
      }
    }

    let pending = this.pendingResourceLists.get(key);
    if (!pending || pending.packetCount !== packetCount || packetIndex === 1) {
      pending = {
        createdAt: now,
        packetCount,
        parts: new Map<number, Buffer>()
      };
      this.pendingResourceLists.set(key, pending);
    }

    pending.parts.set(packetIndex, bodyPart);
    console.log(`Resource list subpackage ${packetIndex}/${packetCount} from ${vehicleId} (partLen=${bodyPart.length})`);

    if (pending.parts.size < packetCount) {
      return;
    }

    const orderedParts: Buffer[] = [];
    for (let i = 1; i <= packetCount; i++) {
      const part = pending.parts.get(i);
      if (!part) {
        console.log(`Resource list assembly missing part ${i}/${packetCount} for ${vehicleId}`);
        return;
      }
      orderedParts.push(part);
    }

    this.pendingResourceLists.delete(key);
    const merged = Buffer.concat(orderedParts);
    console.log(`Resource list merged ${packetCount} packets for ${vehicleId} (len=${merged.length})`);
    const parsedResourceList = this.parseResourceList(vehicleId, merged);
    if (parsedResourceList) {
      this.emitResourceListAlerts(vehicleId, parsedResourceList);
    }
  }

  private parseResourceList(vehicleId: string, body: Buffer): {
    querySerial?: number;
    expectedTotal?: number;
    parsedItems: number;
    items: ResourceVideoItem[];
  } | null {
    if (body.length < 2) {
      console.log(`Resource list body too short: ${body.length} bytes`);
      return null;
    }

    let listOffset = 0;
    let expectedTotal: number | undefined;
    let querySerial: number | undefined;

    // Preferred format per docs: [serial(2)][total(4)][items...]
    if (body.length >= 6 && (body.length - 6) % 28 === 0) {
      querySerial = body.readUInt16BE(0);
      expectedTotal = body.readUInt32BE(2);
      listOffset = 6;
      console.log(`Resource list header: serial=${querySerial}, total=${expectedTotal}`);
    } else if (body.length >= 2 && (body.length - 2) % 28 === 0) {
      // Compatibility: some terminals prepend count(2).
      expectedTotal = body.readUInt16BE(0);
      listOffset = 2;
      console.log(`Resource list header (compat): count=${expectedTotal}`);
    } else {
      // Last-resort: infer an item-aligned offset.
      listOffset = body.length >= 6 ? 6 : 2;
      while (listOffset > 0 && (body.length - listOffset) % 28 !== 0) {
        listOffset--;
      }
      console.log(`Resource list body non-standard: len=${body.length}, inferredOffset=${listOffset}`);
    }

    const payloadBytes = Math.max(0, body.length - listOffset);
    const itemCount = Math.floor(payloadBytes / 28);
    console.log(`Parsed ${itemCount} video file item(s)`);

    const items: ResourceVideoItem[] = [];
    let offset = listOffset;
    for (let i = 0; i < itemCount && offset + 28 <= body.length; i++) {
      const channel = body.readUInt8(offset);
      const startTime = this.parseBcdTime(body.slice(offset + 1, offset + 7));
      const endTime = this.parseBcdTime(body.slice(offset + 7, offset + 13));
      const alarmFlag64 = body.readBigUInt64BE(offset + 13);
      const alarmBits = this.getSetBits64(alarmFlag64);
      const alarmLabels = alarmBits.map((bit) => this.describeResourceAlarmBit(bit));
      const alarmFlag64Hex = `0x${alarmFlag64.toString(16).padStart(16, '0')}`;
      // Keep legacy low-byte compatibility for existing UI fields.
      const alarmType = Number(alarmFlag64 & 0xFFn);
      const mediaType = body.readUInt8(offset + 21);
      const streamType = body.readUInt8(offset + 22);
      const storageType = body.readUInt8(offset + 23);
      const fileSize = body.readUInt32BE(offset + 24);

      const alarmSummary = alarmLabels.length > 0 ? alarmLabels.join(', ') : 'none';
      console.log(`  File ${i + 1}: Ch${channel} ${startTime} to ${endTime} (${fileSize} bytes, alarm64=${alarmFlag64Hex}, flags=${alarmSummary})`);
      items.push({
        channel,
        startTime,
        endTime,
        alarmFlag64Hex,
        alarmBits,
        alarmLabels,
        alarmType,
        mediaType,
        streamType,
        storageType,
        fileSize
      });
      offset += 28;
    }

    if (typeof expectedTotal === 'number' && expectedTotal > 0 && expectedTotal !== items.length) {
      console.log(`Resource list partial parse: parsed=${items.length}, terminalTotal=${expectedTotal}`);
    }

    this.latestResourceLists.set(vehicleId, {
      receivedAt: Date.now(),
      items
    });
    return {
      querySerial,
      expectedTotal,
      parsedItems: items.length,
      items
    };
  }

  private emitResourceListAlerts(
    vehicleId: string,
    resourceList: { items: ResourceVideoItem[] }
  ): void {
    const last = this.lastKnownLocation.get(vehicleId);
    const baseLocation = last
      ? { latitude: last.latitude, longitude: last.longitude }
      : undefined;

    for (const item of resourceList.items) {
      for (const bit of item.alarmBits) {
        const signalCode = this.mapResourceAlarmBitToSignal(bit);
        if (!signalCode) continue;

        const timestamp = this.parseResourceTimestamp(item.endTime) || last?.timestamp || new Date();
        void this.alertManager.processExternalAlert({
          vehicleId,
          channel: item.channel || 1,
          type: this.describeResourceAlarmBit(bit),
          signalCode,
          priority: this.getPriorityForResourceAlarmBit(bit),
          timestamp,
          location: baseLocation,
          signatureScope: `0x1205|ch:${item.channel}|start:${item.startTime}|end:${item.endTime}|bit:${bit}`,
          metadata: {
            ...this.buildAlertContextMetadata(vehicleId, '0x1205', baseLocation),
            sourceType: 'resource_list',
            resourceChannel: item.channel,
            resourceStartTime: item.startTime,
            resourceEndTime: item.endTime,
            resourceAlarmBit: bit,
            resourceAlarmLabel: this.describeResourceAlarmBit(bit),
            resourceAlarmFlag64Hex: item.alarmFlag64Hex,
            resourceMediaType: item.mediaType,
            resourceStreamType: item.streamType,
            resourceStorageType: item.storageType,
            resourceFileSize: item.fileSize
          }
        }).catch((error) => {
          console.error('Failed to process/forward resource-list alert:', error);
        });
      }
    }
  }

  private mapResourceAlarmBitToSignal(bit: number): string | null {
    if (bit === 0) return 'jt808_emergency';
    if (bit === 1) return 'jt808_overspeed';
    if (bit === 2) return 'jt808_fatigue';
    if (bit === 3) return 'jt808_dangerous_driving';
    if (bit === 4) return 'jt808_gnss_module_failure';
    if (bit === 5) return 'jt808_gnss_antenna_disconnected';
    if (bit === 6) return 'jt808_gnss_antenna_short_circuit';
    if (bit === 7) return 'jt808_terminal_power_undervoltage';
    if (bit === 8) return 'jt808_terminal_power_failure';
    if (bit === 9) return 'jt808_terminal_display_failure';
    if (bit === 10) return 'jt808_tts_module_failure';
    if (bit === 11) return 'jt808_camera_failure';
    if (bit === 12) return 'jt808_transport_ic_card_module_failure';
    if (bit === 13) return 'jt808_overspeed_warning';
    if (bit === 14) return 'jt808_fatigue_warning';
    if (bit === 15) return 'jt808_vibration_alarm';
    if (bit === 16) return 'jt808_light_alarm';
    if (bit === 17) return 'jt808_magnetic_inductive_alarm';
    if (bit === 18) return 'jt808_accumulated_driving_time_alarm';
    if (bit === 19) return 'jt808_overtime_parking';
    if (bit === 20) return 'jt808_area_entry_exit_alarm';
    if (bit === 21) return 'jt808_route_entry_exit_alarm';
    if (bit === 22) return 'jt808_route_travel_time_alarm';
    if (bit === 23) return 'jt808_route_deviation_alarm';
    if (bit === 24) return 'jt808_vss_failure';
    if (bit === 25) return 'jt808_abnormal_fuel_capacity';
    if (bit === 26) return 'jt808_vehicle_theft';
    if (bit === 27) return 'jt808_illegal_ignition';
    if (bit === 28) return 'jt808_illegal_displacement';
    if (bit === 29) return 'jt808_collision_warning';
    if (bit === 30) return 'jt808_rollover_warning';
    if (bit === 31) return 'jt808_illegal_door_open_alarm';
    if (bit === 32) return 'jtt1078_video_signal_loss';
    if (bit === 33) return 'jtt1078_video_signal_blocking';
    if (bit === 34) return 'jtt1078_storage_failure';
    if (bit === 35) return 'jtt1078_other_video_failure';
    if (bit === 36) return 'jtt1078_bus_overcrowding';
    if (bit === 37) return 'jtt1078_abnormal_driving';
    if (bit === 38) return 'jtt1078_special_alarm_threshold';
    if (bit > 38 && bit < 64) return `jtt1078_video_alarm_bit_${bit - 32}`;
    return null;
  }

  private getPriorityForResourceAlarmBit(bit: number): AlertPriority {
    if (bit === 0 || bit === 29 || bit === 30) return AlertPriority.CRITICAL;
    if (bit === 2 || bit === 3 || bit === 14 || bit === 15 || bit === 16 || bit === 17 || bit === 27 || bit === 28 || bit === 31 || bit === 34 || bit === 37) return AlertPriority.HIGH;
    if (bit === 1 || bit === 7 || bit === 8 || bit === 11 || bit === 13 || bit === 18 || bit === 19 || bit === 20 || bit === 21 || bit === 22 || bit === 23 || bit === 24 || bit === 25 || bit === 26 || (bit >= 32 && bit <= 38)) return AlertPriority.MEDIUM;
    return AlertPriority.LOW;
  }

  private parseResourceTimestamp(value: string): Date | null {
    if (!value || typeof value !== 'string') return null;
    const isoLike = value.replace(' ', 'T');
    const local = new Date(isoLike);
    if (!Number.isNaN(local.getTime())) return local;
    const utc = new Date(`${isoLike}Z`);
    return Number.isNaN(utc.getTime()) ? null : utc;
  }

  private parseBcdTime(buffer: Buffer): string {
    if (buffer.length < 6) return 'invalid';
    const year = this.fromBcd(buffer[0]) + 2000;
    const month = this.fromBcd(buffer[1]);
    const day = this.fromBcd(buffer[2]);
    const hour = this.fromBcd(buffer[3]);
    const minute = this.fromBcd(buffer[4]);
    const second = this.fromBcd(buffer[5]);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  }

  private getSetBits64(value: bigint): number[] {
    const bits: number[] = [];
    for (let i = 0; i < 64; i++) {
      if (((value >> BigInt(i)) & 1n) === 1n) {
        bits.push(i);
      }
    }
    return bits;
  }

  private describeResourceAlarmBit(bit: number): string {
    const known: Record<number, string> = {
      0: 'Emergency alarm',
      1: 'Overspeed alarm',
      2: 'Fatigue driving alarm',
      3: 'Dangerous driving behavior',
      4: 'GNSS module failure',
      5: 'GNSS antenna disconnected',
      6: 'GNSS antenna short-circuit',
      7: 'Main power undervoltage',
      8: 'Main power power-down',
      9: 'Display failure',
      10: 'TTS module failure',
      11: 'Camera failure',
      12: 'IC module failure',
      13: 'Overspeed warning',
      14: 'Fatigue warning',
      29: 'Collision warning',
      30: 'Rollover warning',
      31: 'Illegal door open alarm',
      // 32-63 extend with JT/T 1078 Table 13 / Table 14 semantics.
      32: 'Video signal loss',
      33: 'Video signal blocking',
      34: 'Storage unit failure',
      35: 'Other video equipment failure',
      36: 'Bus overcrowding',
      37: 'Abnormal driving behavior',
      38: 'Special alarm recording threshold reached'
    };
    return known[bit] || `Alarm bit ${bit}`;
  }
  
  private fromBcd(byte: number): number {
    return ((byte >> 4) & 0x0F) * 10 + (byte & 0x0F);
  }

  queryCapabilities(vehicleId: string): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const command = JTT1078Commands.buildQueryCapabilitiesCommand(
      vehicleId,
      this.getNextSerial()
    );
    
    
    socket.write(command);
    return true;
  }

  requestScreenshot(vehicleId: string, channel: number = 1): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const serverIp = socket.localAddress?.replace('::ffff:', '') || '0.0.0.0';
    const now = new Date();

    const command = ScreenshotCommands.buildSingleFrameRequest(
      vehicleId,
      this.getNextSerial(),
      serverIp,
      this.port,
      this.udpPort,
      channel,
      now
    );

    const legacyCommand = JTT1078Commands.buildPlaybackCommand(
      vehicleId,
      this.getNextSerial(),
      serverIp,
      this.port,
      channel,
      now,
      now,
      4
    );

    console.log(`Screenshot requested for vehicle ${vehicleId}, channel ${channel} (spec + legacy fallback)`);
    socket.write(command);
    this.startVideo(vehicleId, channel);
    setTimeout(() => {
      if (socket.writable) socket.write(legacyCommand);
    }, 120);
    return true;
  }

  private rememberPendingScreenshotRequest(vehicleId: string, channel: number, alertId?: string): void {
    if (!alertId) return;
    const key = vehicleId;
    const list = this.pendingScreenshotRequests.get(key) || [];
    const now = Date.now();
    const ttlMs = 2 * 60 * 1000;

    const pruned = list.filter((item) => now - item.createdAt <= ttlMs);
    const exists = pruned.some((item) => item.alertId === alertId && item.channel === channel);
    if (!exists) {
      pruned.push({
        alertId,
        channel,
        createdAt: now
      });
    }
    this.pendingScreenshotRequests.set(key, pruned);
  }

  private consumePendingScreenshotAlertId(vehicleId: string, channel: number): string | undefined {
    const key = vehicleId;
    const list = this.pendingScreenshotRequests.get(key);
    if (!list || list.length === 0) return undefined;

    const now = Date.now();
    const ttlMs = 2 * 60 * 1000;
    const filtered = list.filter((item) => now - item.createdAt <= ttlMs);
    if (filtered.length === 0) {
      this.pendingScreenshotRequests.delete(key);
      return undefined;
    }

    let idx = filtered.findIndex((item) => item.channel === channel);
    if (idx < 0) idx = 0;

    const [matched] = filtered.splice(idx, 1);
    if (filtered.length > 0) this.pendingScreenshotRequests.set(key, filtered);
    else this.pendingScreenshotRequests.delete(key);
    return matched?.alertId;
  }

  async requestScreenshotWithFallback(
    vehicleId: string,
    channel: number = 1,
    options?: {
      fallback?: boolean;
      fallbackDelayMs?: number;
      alertId?: string;
      captureVideoEvidence?: boolean;
      videoDurationSec?: number;
      preferFrameFirst?: boolean;
    }
  ): Promise<{ success: boolean; fallback: ScreenshotFallbackResult }> {
    const fallbackEnabled = options?.fallback !== false;
    const fallbackDelayMs = Math.max(0, Math.min(5000, Number(options?.fallbackDelayMs) || 1800));
    const captureVideoEvidence = options?.captureVideoEvidence === true;
    const videoDurationSec = Math.max(3, Math.min(20, Number(options?.videoDurationSec) || 8));
    const preferFrameFirst = options?.preferFrameFirst === true;
    this.rememberPendingScreenshotRequest(vehicleId, channel, options?.alertId);
    const success = this.requestScreenshot(vehicleId, channel);

    if (!fallbackEnabled) {
      return { success, fallback: { ok: false, reason: 'disabled' } };
    }

    if (!this.videoProcessingEnabled) {
      return { success, fallback: { ok: false, reason: 'video processing disabled on this server' } };
    }

    let fallback: ScreenshotFallbackResult = { ok: false, reason: 'not attempted' };
    if (preferFrameFirst) {
      fallback = await this.captureScreenshotFromHLS(vehicleId, channel, options?.alertId);
      for (let attempt = 0; attempt < 2 && !fallback.ok; attempt++) {
        await new Promise((r) => setTimeout(r, 700));
        fallback = await this.captureScreenshotFromHLS(vehicleId, channel, options?.alertId);
      }
    }

    if (!fallback.ok) {
      await new Promise((r) => setTimeout(r, fallbackDelayMs));
      fallback = await this.captureScreenshotFromHLS(vehicleId, channel, options?.alertId);
      // HLS playlists/segments can appear a few seconds after startVideo().
      for (let attempt = 0; attempt < 3 && !fallback.ok; attempt++) {
        await new Promise((r) => setTimeout(r, 1200));
        fallback = await this.captureScreenshotFromHLS(vehicleId, channel, options?.alertId);
      }
    }
    if (captureVideoEvidence) {
      let videoBackup = await this.captureVideoEvidenceFromHLS(vehicleId, channel, videoDurationSec, options?.alertId);
      if (!videoBackup.ok) {
        // Retry once after segments are more likely to exist.
        await new Promise((r) => setTimeout(r, 1500));
        videoBackup = await this.captureVideoEvidenceFromHLS(vehicleId, channel, videoDurationSec, options?.alertId);
      }
      if (videoBackup.ok && videoBackup.path) {
        fallback.videoEvidencePath = videoBackup.path;
        if (!fallback.ok) {
          const fromVideo = await this.captureScreenshotFromVideoFile(
            vehicleId,
            channel,
            videoBackup.path,
            options?.alertId
          );
          if (fromVideo.ok) {
            fallback.ok = true;
            fallback.imageId = fromVideo.imageId;
            fallback.reason = undefined;
          } else {
            fallback.reason = fallback.reason || fromVideo.reason || 'video frame extraction failed';
          }
        }
      } else {
        fallback.videoEvidenceReason = videoBackup.reason;
      }
    }
    if (!success && !fallback.ok) {
      return { success: false, fallback: { ...fallback, reason: fallback.reason || 'vehicle not connected' } };
    }
    return { success, fallback };
  }

  private async captureVideoEvidenceFromHLS(
    vehicleId: string,
    channel: number,
    durationSec: number,
    alertId?: string
  ): Promise<{ ok: boolean; path?: string; reason?: string }> {
    if (!this.videoProcessingEnabled) {
      return { ok: false, reason: 'video processing disabled on this server' };
    }
    try {
      const playlistPath = path.join(process.cwd(), 'hls', vehicleId, `channel_${channel}`, 'playlist.m3u8');
      if (!fs.existsSync(playlistPath)) {
        return { ok: false, reason: 'HLS playlist not found' };
      }

      const evidenceDir = path.join(process.cwd(), 'recordings', vehicleId, 'evidence');
      if (!fs.existsSync(evidenceDir)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
      }

      const base = alertId ? `${alertId}_ch${channel}` : `screenshot_ch${channel}`;
      const outPath = path.join(evidenceDir, `${base}_${Date.now()}.mp4`);

      const ffmpegOk = await new Promise<boolean>((resolve) => {
        const ffmpeg = spawn('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', playlistPath,
          '-t', String(durationSec),
          '-c', 'copy',
          '-movflags', '+faststart',
          outPath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        const timeout = setTimeout(() => {
          ffmpeg.kill('SIGKILL');
          resolve(false);
        }, 12000);

        ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
        ffmpeg.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
        ffmpeg.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0 && fs.existsSync(outPath)) {
            resolve(true);
          } else {
            if (stderr) {
              if (this.shouldLogNoisy(`video_fallback_ffmpeg:${vehicleId}:${channel}`, 10000)) {
                console.warn(`Video evidence fallback ffmpeg stderr: ${stderr.slice(0, 300)}`);
              }
            }
            resolve(false);
          }
        });
      });

      if (!ffmpegOk) {
        return { ok: false, reason: 'ffmpeg video capture failed' };
      }

      if (alertId) {
        await this.alertManager.registerAlertVideoEvidence({
          alertId,
          channel,
          filePath: outPath,
          source: 'hls_backup',
          durationSec
        }).catch((err: any) => {
          console.warn(`Failed to register fallback video evidence for ${alertId}:`, err?.message || err);
        });
      }

      return { ok: true, path: outPath };
    } catch (error: any) {
      return { ok: false, reason: error?.message || 'video evidence fallback error' };
    }
  }

  private async captureScreenshotFromVideoFile(
    vehicleId: string,
    channel: number,
    videoPath: string,
    alertId?: string
  ): Promise<ScreenshotFallbackResult> {
    try {
      if (!videoPath || !fs.existsSync(videoPath)) {
        return { ok: false, reason: 'video file not found for frame capture' };
      }

      const imageData = await new Promise<Buffer | null>((resolve) => {
        const ffmpeg = spawn('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-ss', '00:00:01',
          '-i', videoPath,
          '-frames:v', '1',
          '-f', 'image2pipe',
          '-vcodec', 'mjpeg',
          'pipe:1'
        ], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const chunks: Buffer[] = [];
        let done = false;
        const finish = (data: Buffer | null) => {
          if (done) return;
          done = true;
          resolve(data);
        };

        const timeout = setTimeout(() => {
          ffmpeg.kill('SIGKILL');
          finish(null);
        }, 6000);

        ffmpeg.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
        ffmpeg.on('error', () => {
          clearTimeout(timeout);
          finish(null);
        });
        ffmpeg.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0 && chunks.length > 0) {
            finish(Buffer.concat(chunks));
          } else {
            finish(null);
          }
        });
      });

      if (!imageData || imageData.length < 4) {
        return { ok: false, reason: 'empty frame from video' };
      }

      const imageId = await this.imageStorage.saveImage(vehicleId, channel, imageData, alertId);
      if (alertId) {
        await this.alertManager.registerAlertScreenshotEvidence({
          alertId,
          imageId: String(imageId),
          channel,
          source: 'video_frame_fallback'
        }).catch((err: any) => {
          console.warn(`Failed to register video-frame screenshot evidence for ${alertId}:`, err?.message || err);
        });
      }
      console.log(`Alert ${alertId || 'manual'}: Video-frame fallback screenshot saved for ${vehicleId} ch${channel}`);
      return { ok: true, imageId };
    } catch (error: any) {
      return { ok: false, reason: error?.message || 'video frame screenshot fallback error' };
    }
  }

  private async captureScreenshotFromHLS(vehicleId: string, channel: number, alertId?: string): Promise<ScreenshotFallbackResult> {
    if (!this.videoProcessingEnabled) {
      return { ok: false, reason: 'video processing disabled on this server' };
    }
    try {
      const playlistPath = path.join(process.cwd(), 'hls', vehicleId, `channel_${channel}`, 'playlist.m3u8');
      if (!fs.existsSync(playlistPath)) {
        console.log(`HLS fallback skipped: playlist not found for ${vehicleId} ch${channel}`);
        return { ok: false, reason: 'HLS playlist not found' };
      }

      const imageData = await new Promise<Buffer | null>((resolve) => {
        const ffmpeg = spawn('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', playlistPath,
          '-frames:v', '1',
          '-f', 'image2pipe',
          '-vcodec', 'mjpeg',
          'pipe:1'
        ], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const chunks: Buffer[] = [];
        let done = false;

        const finish = (data: Buffer | null) => {
          if (done) return;
          done = true;
          resolve(data);
        };

        const timeout = setTimeout(() => {
          ffmpeg.kill('SIGKILL');
          finish(null);
        }, 6000);

        ffmpeg.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
        ffmpeg.on('error', () => {
          clearTimeout(timeout);
          finish(null);
        });
        ffmpeg.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0 && chunks.length > 0) {
            finish(Buffer.concat(chunks));
          } else {
            finish(null);
          }
        });
      });

      if (!imageData || imageData.length < 4) {
        console.log(`HLS fallback capture failed for ${vehicleId} ch${channel}`);
        return { ok: false, reason: 'empty frame' };
      }

      const imageId = await this.imageStorage.saveImage(vehicleId, channel, imageData, alertId);
      if (alertId) {
        await this.alertManager.registerAlertScreenshotEvidence({
          alertId,
          imageId: String(imageId),
          channel,
          source: 'hls_fallback'
        }).catch((err: any) => {
          console.warn(`Failed to register HLS screenshot evidence for ${alertId}:`, err?.message || err);
        });
      }
      console.log(`Alert ${alertId || 'manual'}: HLS fallback screenshot saved for ${vehicleId} ch${channel}`);
      return { ok: true, imageId };
    } catch (error: any) {
      console.error(`HLS fallback screenshot error for ${vehicleId} ch${channel}:`, error?.message || error);
      return { ok: false, reason: error?.message || 'fallback error' };
    }
  }

  private isVehicleConnected(vehicleId: string): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    return !!(vehicle && socket && vehicle.connected);
  }

  private enqueuePendingCameraRequest(req: PendingCameraRequest): void {
    const key = req.vehicleId;
    const list = this.pendingCameraRequests.get(key) || [];
    const dedupeKey = `${req.channel}|${req.startTime}|${req.endTime}|${req.queryResources ? 1 : 0}|${req.requestDownload ? 1 : 0}`;
    const exists = list.some((r) =>
      `${r.channel}|${r.startTime}|${r.endTime}|${r.queryResources ? 1 : 0}|${r.requestDownload ? 1 : 0}` === dedupeKey
    );
    if (exists) return;
    list.push(req);
    this.pendingCameraRequests.set(key, list);
  }

  private flushPendingCameraRequests(vehicleId: string): void {
    if (!this.isVehicleConnected(vehicleId)) return;
    const list = this.pendingCameraRequests.get(vehicleId);
    if (!list || list.length === 0) return;

    this.pendingCameraRequests.delete(vehicleId);
    const now = Date.now();
    for (const req of list) {
      // Drop very old requests (10 minutes)
      if (now - req.createdAt > 10 * 60 * 1000) continue;
      const start = new Date(req.startTime);
      const end = new Date(req.endTime);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      if (req.queryResources) this.queryResourceList(req.vehicleId, req.channel, start, end);
      this.requestCameraVideo(req.vehicleId, req.channel, start, end);
      if (req.requestDownload) this.requestCameraVideoDownload(req.vehicleId, req.channel, start, end);
    }
  }

  scheduleCameraReportRequests(
    vehicleId: string,
    channel: number,
    startTime: Date,
    endTime: Date,
    options?: { queryResources?: boolean; requestDownload?: boolean }
  ): { requested: boolean; queued: boolean; querySent: boolean; downloadSent: boolean } {
    const queryResources = options?.queryResources !== false;
    const requestDownload = options?.requestDownload === true;

    if (this.isVehicleConnected(vehicleId)) {
      const querySent = queryResources ? this.queryResourceList(vehicleId, channel, startTime, endTime) : false;
      const requested = this.requestCameraVideo(vehicleId, channel, startTime, endTime);
      const downloadSent = requestDownload ? this.requestCameraVideoDownload(vehicleId, channel, startTime, endTime) : false;
      return { requested, queued: false, querySent, downloadSent };
    }

    this.enqueuePendingCameraRequest({
      vehicleId,
      channel,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      queryResources,
      requestDownload,
      createdAt: Date.now()
    });
    return { requested: false, queued: true, querySent: false, downloadSent: false };
  }

  requestCameraVideo(vehicleId: string, channel: number, startTime: Date, endTime: Date): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const serverIp = socket.localAddress?.replace('::ffff:', '') || '0.0.0.0';
    
    // Use JTT 1078-2016 compliant video request (0x9201)
    const serial = this.getNextSerial();
    const commandBody = AlertVideoCommands.createAlertVideoRequest(
      vehicleId,
      channel,
      startTime,
      endTime,
      serverIp,
      this.udpPort
    );
    
    const command = this.buildMessage(0x9201, vehicleId, serial, commandBody);
    
    console.log(`🎥 Camera video requested: ${vehicleId} ch${channel} from ${startTime.toISOString()} to ${endTime.toISOString()}`);
    socket.write(command);
    this.pushOutboundMessageTrace(vehicleId, 0x9201, serial, command, commandBody, {
      parser: 'outbound-video-request-0x9201',
      channel,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString()
    });
    return true;
  }

  requestCameraVideoDownload(vehicleId: string, channel: number, _startTime: Date, _endTime: Date): boolean {
    if (this.shouldLogNoisy('ftp_disabled_video_download', 60000)) {
      console.log(`FTP download disabled; skipping 0x9206 request for ${vehicleId} ch${channel}.`);
    }
    return false;
  }

  queryResourceList(vehicleId: string, channel: number, startTime: Date, endTime: Date): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const serial = this.getNextSerial();
    const command = JTT1078Commands.buildQueryResourceListCommand(
      vehicleId,
      serial,
      channel,
      startTime,
      endTime
    );
    
    console.log(`📝 Query resource list: ${vehicleId} ch${channel} from ${startTime.toISOString()} to ${endTime.toISOString()}`);
    socket.write(command);
    this.pushOutboundMessageTrace(vehicleId, 0x9205, serial, command, command.slice(12, -2), {
      parser: 'outbound-resource-query-0x9205',
      channel,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString()
    });
    return true;
  }

  // Public methods for video control
  startVideo(vehicleId: string, channel: number = 1): boolean {
    console.log(`🎬 startVideo called: vehicleId=${vehicleId}, channel=${channel}`);
    
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      console.log(`  ❌ Cannot start video: vehicle=${!!vehicle}, socket=${!!socket}, connected=${vehicle?.connected}`);
      return false;
    }

    // Initialize circular buffer for this channel
    this.alertManager.initializeBuffer(vehicleId, channel);

    const serverIp = process.env.SERVER_IP || socket.localAddress?.replace('::ffff:', '') || '0.0.0.0';
    
    const serial = this.getNextSerial();
    const command = JTT1078Commands.buildStartVideoCommand(
      vehicleId,
      serial,
      serverIp,
      this.port,      // TCP port for signaling
      this.udpPort,   // UDP port for RTP video stream
      channel,
      1,              // 1 = Video only
      1               // 1 = Sub stream (lower bitrate, faster)
    );
    
    console.log(`📡 Sending 0x9101: ServerIP=${serverIp}, TCP=${this.port}, UDP=${this.udpPort}, Channel=${channel}`);
    socket.write(command);
    this.pushOutboundMessageTrace(vehicleId, 0x9101, serial, command, command.slice(12, -2), {
      parser: 'outbound-realtime-video-request-0x9101',
      channel,
      serverIp,
      tcpPort: this.port,
      udpPort: this.udpPort
    });
    vehicle.activeStreams.add(channel);
    
    return true;
  }

  optimizeVideoParameters(vehicleId: string, channel: number = 1): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const command = JTT1078Commands.buildSetVideoParametersCommand(
      vehicleId,
      this.getNextSerial(),
      channel,
      1,    // CIF (352x288)
      15,   // 15 fps
      512   // 512 kbps
    );
    
    console.log(`⚡ Optimizing camera: ${vehicleId} ch${channel} -> CIF/15fps/512kbps`);
    socket.write(command);
    return true;
  }

  setVideoAlarmMask(vehicleId: string, maskWord: number = 0): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const command = JTT1078Commands.buildSetVideoAlarmMaskCommand(
      vehicleId,
      this.getNextSerial(),
      maskWord >>> 0
    );
    socket.write(command);
    return true;
  }

  setImageAnalysisAlarmParams(
    vehicleId: string,
    approvedPassengers: number,
    fatigueThreshold: number
  ): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const command = JTT1078Commands.buildSetImageAnalysisAlarmParamsCommand(
      vehicleId,
      this.getNextSerial(),
      approvedPassengers,
      fatigueThreshold
    );
    socket.write(command);
    return true;
  }

  switchStream(vehicleId: string, channel: number, streamType: 0 | 1): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    const socket = this.connections.get(vehicleId);
    
    if (!vehicle || !socket || !vehicle.connected) {
      return false;
    }

    const serial = this.getNextSerial();
    const command = JTT1078Commands.buildStreamControlCommand(
      vehicleId,
      serial,
      channel,
      1, // Switch stream
      0,
      streamType
    );
    
    console.log(`🔄 Switching to ${streamType === 0 ? 'MAIN' : 'SUB'} stream: ${vehicleId} channel ${channel}`);
    socket.write(command);
    this.pushOutboundMessageTrace(vehicleId, 0x9102, serial, command, command.slice(12, -2), {
      parser: 'outbound-stream-control-0x9102',
      channel,
      controlInstruction: 1,
      switchStreamType: streamType
    });
    return true;
  }

  stopVideo(vehicleId: string, channel: number = 1): boolean {
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle) return false;
    
    vehicle.activeStreams.delete(channel);
    
    return true;
  }

  getVehicles(): Vehicle[] {
    return Array.from(this.vehicles.values());
  }

  resolveVehicleIdByIp(ipAddress: string): string {
    const ip = String(ipAddress || '').replace('::ffff:', '').trim();
    if (!ip) return '';
    return this.ipToVehicle.get(ip) || ip;
  }

  getVehicle(id: string): Vehicle | undefined {
    return this.vehicles.get(id);
  }

  getLatestResourceList(vehicleId: string): { receivedAt: number; items: ResourceVideoItem[] } | undefined {
    return this.latestResourceLists.get(vehicleId);
  }

  getRecentMessageTraces(options?: {
    vehicleId?: string;
    messageId?: number;
    direction?: 'inbound' | 'outbound';
    limit?: number;
  }): MessageTraceEntry[] {
    const vehicleId = options?.vehicleId ? String(options.vehicleId).trim() : '';
    const messageId = typeof options?.messageId === 'number' ? options?.messageId : undefined;
    const direction = options?.direction;
    const limit = Math.max(1, Math.min(Number(options?.limit || 50), this.maxMessageTraceBuffer));

    let rows = [...this.recentMessageTraces];
    if (vehicleId) {
      rows = rows.filter((row) => row.vehicleId === vehicleId);
    }
    if (typeof messageId === 'number' && Number.isFinite(messageId)) {
      rows = rows.filter((row) => row.messageId === messageId);
    }
    if (direction) {
      rows = rows.filter((row) => row.direction === direction);
    }

    return rows.slice(-limit).reverse();
  }

  async getAlerts() {
    return await this.alertStorage.getActiveAlerts();
  }

  async getDevices() {
    return await this.deviceStorage.getDevices();
  }

  private pushMessageTrace(message: any, rawFrame?: Buffer, parse?: Record<string, unknown>): void {
    if (!this.messageTraceEnabled) return;
    const trace: MessageTraceEntry = {
      id: ++this.messageTraceSeq,
      receivedAt: new Date().toISOString(),
      direction: 'inbound',
      vehicleId: String(message?.terminalPhone || ''),
      messageId: Number(message?.messageId || 0),
      messageIdHex: `0x${Number(message?.messageId || 0).toString(16).padStart(4, '0')}`,
      serialNumber: Number(message?.serialNumber || 0),
      bodyLength: Number(message?.body?.length || 0),
      isSubpackage: !!message?.isSubpackage,
      packetCount: message?.packetCount,
      packetIndex: message?.packetIndex,
      rawFrameHex: (rawFrame || Buffer.alloc(0)).toString('hex'),
      bodyHex: (message?.body || Buffer.alloc(0)).toString('hex'),
      bodyTextPreview: this.buildPayloadPreview(message?.body || Buffer.alloc(0), 320),
      parse: parse || undefined
    };

    this.recentMessageTraces.push(trace);
    if (this.recentMessageTraces.length > this.maxMessageTraceBuffer) {
      const overflow = this.recentMessageTraces.length - this.maxMessageTraceBuffer;
      this.recentMessageTraces.splice(0, overflow);
    }

    RawIngestLogger.write('jt808_message_trace', trace as unknown as Record<string, unknown>);
    ProtocolMessageArchive.write({
      ts: trace.receivedAt,
      direction: trace.direction || 'inbound',
      vehicleId: trace.vehicleId || null,
      messageId: trace.messageId,
      messageIdHex: trace.messageIdHex,
      serialNumber: trace.serialNumber,
      bodyLength: trace.bodyLength,
      isSubpackage: trace.isSubpackage,
      packetCount: trace.packetCount ?? null,
      packetIndex: trace.packetIndex ?? null,
      parseSuccess: true,
      rawFrameHex: trace.rawFrameHex,
      bodyHex: trace.bodyHex,
      bodyTextPreview: trace.bodyTextPreview,
      parse: trace.parse
    });
    void this.protocolMessageStorage.save(trace).catch((error) => {
      console.error('Failed to persist inbound protocol message trace:', error);
    });
    try {
      this.messageTraceCallback?.(trace);
    } catch {
      // Never allow websocket broadcast hooks to break protocol ingest.
    }
  }

  private pushOutboundMessageTrace(
    vehicleId: string,
    messageId: number,
    serialNumber: number,
    rawFrame: Buffer,
    body: Buffer,
    parse?: Record<string, unknown>
  ): void {
    if (!this.messageTraceEnabled) return;
    const trace: MessageTraceEntry = {
      id: ++this.messageTraceSeq,
      receivedAt: new Date().toISOString(),
      direction: 'outbound',
      vehicleId: String(vehicleId || ''),
      messageId: Number(messageId || 0),
      messageIdHex: `0x${Number(messageId || 0).toString(16).padStart(4, '0')}`,
      serialNumber: Number(serialNumber || 0),
      bodyLength: Number(body?.length || 0),
      isSubpackage: false,
      rawFrameHex: (rawFrame || Buffer.alloc(0)).toString('hex'),
      bodyHex: (body || Buffer.alloc(0)).toString('hex'),
      bodyTextPreview: this.buildPayloadPreview(body || Buffer.alloc(0), 320),
      parse: parse || undefined
    };

    this.recentMessageTraces.push(trace);
    if (this.recentMessageTraces.length > this.maxMessageTraceBuffer) {
      const overflow = this.recentMessageTraces.length - this.maxMessageTraceBuffer;
      this.recentMessageTraces.splice(0, overflow);
    }

    RawIngestLogger.write('jt808_message_trace', trace as unknown as Record<string, unknown>);
    ProtocolMessageArchive.write({
      ts: trace.receivedAt,
      direction: trace.direction || 'outbound',
      vehicleId: trace.vehicleId || null,
      messageId: trace.messageId,
      messageIdHex: trace.messageIdHex,
      serialNumber: trace.serialNumber,
      bodyLength: trace.bodyLength,
      isSubpackage: trace.isSubpackage,
      packetCount: trace.packetCount ?? null,
      packetIndex: trace.packetIndex ?? null,
      parseSuccess: true,
      rawFrameHex: trace.rawFrameHex,
      bodyHex: trace.bodyHex,
      bodyTextPreview: trace.bodyTextPreview,
      parse: trace.parse
    });
    void this.protocolMessageStorage.save(trace).catch((error) => {
      console.error('Failed to persist outbound protocol message trace:', error);
    });
    try {
      this.messageTraceCallback?.(trace);
    } catch {
      // Never allow websocket broadcast hooks to break protocol ingest.
    }
  }

  private extractLocationAdditionalInfoFields(body: Buffer): Array<{
    idHex: string;
    idDec: number;
    length: number;
    dataHex: string;
  }> {
    const fields: Array<{
      idHex: string;
      idDec: number;
      length: number;
      dataHex: string;
    }> = [];

    if (!body || body.length < 30) return fields;

    let offset = 28;
    while (offset + 2 <= body.length) {
      const infoId = body.readUInt8(offset);
      const infoLength = body.readUInt8(offset + 1);
      if (offset + 2 + infoLength > body.length) break;

      const infoData = body.slice(offset + 2, offset + 2 + infoLength);
      fields.push({
        idHex: `0x${infoId.toString(16).padStart(2, '0')}`,
        idDec: infoId,
        length: infoLength,
        dataHex: infoData.toString('hex').slice(0, 512)
      });

      offset += 2 + infoLength;
      if (fields.length >= 64) break;
    }

    return fields;
  }

  private handleMultimediaEvent(message: any, socket: net.Socket): void {
    if (message.body.length >= 8) {
      const multimediaId = message.body.readUInt32BE(0);
      const multimediaType = message.body.readUInt8(4);
      const multimediaFormat = message.body.readUInt8(5);
      const eventCode = message.body.readUInt8(6);
      const channel = message.body.readUInt8(7);

      console.log(
        `Multimedia event from ${message.terminalPhone}: id=${multimediaId}, type=${multimediaType}, format=${multimediaFormat}, event=${eventCode}, ch=${channel}`
      );

      const mapped = this.mapMultimediaEvent(eventCode);
      if (mapped) {
        const last = this.lastKnownLocation.get(message.terminalPhone);
        void this.alertManager.processExternalAlert({
          vehicleId: message.terminalPhone,
          channel: channel || 1,
          type: mapped.type,
          signalCode: `external_multimedia_event_${eventCode}`,
          priority: mapped.priority,
          timestamp: last?.timestamp || new Date(),
          location: last ? { latitude: last.latitude, longitude: last.longitude } : undefined,
          metadata: {
            ...this.buildAlertContextMetadata(message.terminalPhone, '0x0800'),
            multimediaId,
            multimediaType,
            multimediaFormat,
            eventCode
          }
        }).catch((error) => {
          console.error('Failed to process/forward multimedia-event alert:', error);
        });
      }

      const last = this.lastKnownLocation.get(message.terminalPhone);
      const vendorMapped = this.detectVendorAlarmsFromPayload(message.body, 'global_payload');
      this.emitVendorMappedAlerts(message.terminalPhone, vendorMapped, {
        sourceMessageId: '0x0800',
        telemetryPrefix: 'multimedia_event',
        timestamp: last?.timestamp || new Date(),
        location: last ? { latitude: last.latitude, longitude: last.longitude } : undefined,
        defaultChannel: channel || 1,
        metadata: {
          multimediaId,
          multimediaType,
          multimediaFormat,
          eventCode,
          rawPayloadHash: this.buildPayloadHash(message.body)
        }
      });
    }

    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    socket.write(response);
  }

  private handleCustomMessage(message: any, socket: net.Socket): void {
    // Strict mode: do not generate alerts from custom payload keywords.
    // Keep these packets for diagnostics only to avoid false positive alerts.
    this.pushMessageTrace(message, undefined, {
      parser: 'custom-message',
      parseSuccess: false,
      reason: 'strict_protocol_mode_no_custom_keyword_mapping',
      bodyTextPreview: this.buildPayloadPreview(message.body || Buffer.alloc(0), 220)
    });

    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    socket.write(response);
  }

  private buildPayloadPreview(payload: Buffer, maxLen: number = 220): string {
    if (!payload || payload.length === 0) return '(empty payload)';
    const ascii = payload
      .toString('latin1')
      .replace(/[^\x20-\x7E]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (ascii.length > 0) {
      return ascii.slice(0, maxLen);
    }
    const hex = payload.toString('hex');
    return `[hex] ${hex.slice(0, maxLen)}`;
  }

  private mapMultimediaEvent(eventCode: number): { type: string; priority: AlertPriority } | null {
    // JT/T 808 multimedia event codes commonly used by terminals:
    // 0 platform command, 1 scheduled action, 2 robbery alarm, 3 collision/rollover,
    // 4/5 door open/close photos, 6 door open->close with speed crossing threshold, 7 fixed-distance photos.
    if (eventCode === 0 || eventCode === 1) return null;

    if (eventCode === 2) {
      return { type: 'Robbery Alarm Trigger', priority: AlertPriority.CRITICAL };
    }
    if (eventCode === 3) {
      return { type: 'Collision/Rollover Trigger', priority: AlertPriority.CRITICAL };
    }
    if (eventCode === 4) {
      return { type: 'Door Open Photo Event', priority: AlertPriority.LOW };
    }
    if (eventCode === 5) {
      return { type: 'Door Close Photo Event', priority: AlertPriority.LOW };
    }
    if (eventCode === 6) {
      return { type: 'Door Transition Speed Event', priority: AlertPriority.MEDIUM };
    }
    if (eventCode === 7) {
      return { type: 'Fixed Distance Photo Event', priority: AlertPriority.LOW };
    }

    // Other values are reserved/terminal-specific.
    return null;
  }

  private decodeCustomPayloadText(payload: Buffer): string | null {
    if (!payload || payload.length === 0) return null;

    const asciiSanitized = payload
      .toString('latin1')
      .replace(/[^\x20-\x7E]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const candidates = [
      payload.toString('utf8'),
      payload.toString('latin1'),
      asciiSanitized
    ]
      .map((v) => v.replace(/\0/g, '').trim())
      .filter((v) => v.length > 0);

    let best: string | null = null;
    let bestScore = 0;
    for (const text of candidates) {
      let printable = 0;
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        if ((code >= 32 && code <= 126) || ch === '\r' || ch === '\n' || ch === '\t') printable++;
      }
      const score = printable / Math.max(text.length, 1);
      if (score > bestScore) {
        bestScore = score;
        best = text;
      }
    }

    if (!best || bestScore < 0.45) return null;
    return best.slice(0, 400);
  }

  private extractKeywordAlertFromBinary(payload: Buffer): {
    type: string;
    priority: AlertPriority;
    signalCode: string;
    channel?: number;
  } | null {
    if (!payload || payload.length === 0) return null;

    // 1) Try keyword extraction from a binary-tolerant sanitized text stream.
    const sanitizedText = payload
      .toString('latin1')
      .replace(/[^\x20-\x7E]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const keywordMatch = this.extractKeywordAlert(sanitizedText);
    if (keywordMatch) return keywordMatch;

    // 2) Try protocol alarm type codes (Table 38 style): 0x0101..0x0107.
    const codeMap: Record<number, { type: string; priority: AlertPriority; signalCode: string }> = {
      0x0101: { type: 'Video Signal Loss', priority: AlertPriority.MEDIUM, signalCode: 'platform_video_alarm_0101' },
      0x0102: { type: 'Video Signal Blocking', priority: AlertPriority.MEDIUM, signalCode: 'platform_video_alarm_0102' },
      0x0103: { type: 'Storage Unit Failure', priority: AlertPriority.HIGH, signalCode: 'platform_video_alarm_0103' },
      0x0104: { type: 'Other Video Equipment Failure', priority: AlertPriority.MEDIUM, signalCode: 'platform_video_alarm_0104' },
      0x0105: { type: 'Bus Overcrowding', priority: AlertPriority.MEDIUM, signalCode: 'platform_video_alarm_0105' },
      0x0106: { type: 'Abnormal Driving Behavior', priority: AlertPriority.HIGH, signalCode: 'platform_video_alarm_0106' },
      0x0107: { type: 'Special Alarm Threshold', priority: AlertPriority.MEDIUM, signalCode: 'platform_video_alarm_0107' }
    };

    for (let i = 0; i <= payload.length - 2; i++) {
      const code = payload.readUInt16BE(i);
      if (codeMap[code]) {
        return { ...codeMap[code] };
      }
    }

    return null;
  }

  private extractKeywordAlert(text: string): {
    type: string;
    priority: AlertPriority;
    signalCode: string;
    channel?: number;
  } | null {
    const patterns: Array<{ re: RegExp; type: string; priority: AlertPriority; signalCode: string }> = [
      { re: /\b(panic|sos|emergency)\b/i, type: 'Emergency Alarm', priority: AlertPriority.CRITICAL, signalCode: 'custom_keyword_emergency' },
      { re: /\b(collision|rollover|crash|accident)\b/i, type: 'Collision/Accident', priority: AlertPriority.CRITICAL, signalCode: 'custom_keyword_collision' },
      { re: /\b(fatigue|yawn|drowsy|sleepy)\b/i, type: 'Driver Fatigue', priority: AlertPriority.HIGH, signalCode: 'custom_keyword_fatigue' },
      { re: /\b(seat\s*belt|seatbelt|seatbelt\s*detected|unbelted|no\s*seat\s*belt|without\s*seat\s*belt)\b/i, type: 'No Seatbelt', priority: AlertPriority.HIGH, signalCode: 'custom_keyword_no_seatbelt' },
      { re: /\b(smok|cigarette)\b/i, type: 'Smoking While Driving', priority: AlertPriority.HIGH, signalCode: 'custom_keyword_smoking' },
      { re: /\b(phone|cellphone|mobile)\b/i, type: 'Phone Use While Driving', priority: AlertPriority.HIGH, signalCode: 'custom_keyword_phone' },
      { re: /\b(speed|overspeed)\b/i, type: 'Overspeed Alert', priority: AlertPriority.HIGH, signalCode: 'custom_keyword_speed' },
      { re: /\b(camera).*(covered|blocked|mask|obstruct)/i, type: 'Camera Covered', priority: AlertPriority.HIGH, signalCode: 'custom_keyword_camera_covered' },
      { re: /\b(storage|memory).*(fail|error|fault)/i, type: 'Storage Failure', priority: AlertPriority.HIGH, signalCode: 'custom_keyword_storage_failure' },
      { re: /\b(gnss|gps).*(antenna).*(disconnect|fault|error)/i, type: 'GNSS Antenna Issue', priority: AlertPriority.MEDIUM, signalCode: 'custom_keyword_gnss_antenna' },
      { re: /\b(alert|alarm|warning|violation)\b/i, type: 'Custom Alert', priority: AlertPriority.MEDIUM, signalCode: 'custom_keyword_alert' }
    ];

    const matched = patterns.find((p) => p.re.test(text));
    if (!matched) return null;

    const channelMatch = text.match(/\bch(?:annel)?\s*[:#-]?\s*(\d{1,2})\b/i);
    const channel = channelMatch ? Number(channelMatch[1]) : undefined;

    return {
      type: matched.type,
      priority: matched.priority,
      signalCode: matched.signalCode,
      channel
    };
  }

  private async handleMultimediaData(message: any, socket: net.Socket): Promise<void> {
    try {
      const multimedia = MultimediaParser.parseMultimediaData(message.body, message.terminalPhone);

      if (multimedia && multimedia.type === 'jpeg') {
        // Save image to Supabase and database (with error handling)
        const pendingAlertId = this.consumePendingScreenshotAlertId(message.terminalPhone, multimedia.channel);
        const imageId = await this.imageStorage
          .saveImage(message.terminalPhone, multimedia.channel, multimedia.data, pendingAlertId)
          .catch((err) => {
            console.error(`Failed to save image: ${err.message}`);
            return null;
          });

        if (pendingAlertId && imageId) {
          await this.alertManager.registerAlertScreenshotEvidence({
            alertId: pendingAlertId,
            imageId: String(imageId),
            channel: multimedia.channel,
            source: 'multimedia_0801'
          }).catch((err: any) => {
            console.warn(`Failed to register multimedia screenshot evidence for ${pendingAlertId}:`, err?.message || err);
          });
        }

        console.log(`Saved image from ${message.terminalPhone} channel ${multimedia.channel}`);
      }
    } catch (error) {
      console.error('Error handling multimedia data:', error);
    }

    const response = JTT1078Commands.buildGeneralResponse(
      message.terminalPhone,
      this.getNextSerial(),
      message.serialNumber,
      message.messageId,
      0
    );
    socket.write(response);
  }
}














