// JT/T 808 & JT/T 1078 Protocol Types and Enums

export enum JTT808MessageType {
  TERMINAL_REGISTER = 0x0100,
  TERMINAL_AUTH = 0x0102,
  HEARTBEAT = 0x0002,
  LOCATION_REPORT = 0x0200,
  PLATFORM_GENERAL_RESPONSE = 0x8001,
  START_VIDEO_REQUEST = 0x9101
}

export enum JTT1078SubpackageFlag {
  ATOMIC = 0b00,      // Complete frame in single packet
  FIRST = 0b01,       // First subpackage of frame
  LAST = 0b10,        // Last subpackage of frame  
  MIDDLE = 0b11       // Middle subpackage of frame
}

export interface JTT808Message {
  messageId: number;
  bodyLength: number;
  terminalPhone: string;
  serialNumber: number;
  protocolVersion?: number;
  versionFlag?: boolean;
  isSubpackage?: boolean;
  packetCount?: number;
  packetIndex?: number;
  body: Buffer;
  checksum: number;
}

export interface JTT1078RTPHeader {
  frameHeader: number;    // 0x30316364
  version: number;        // RTP version
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  simCard: string;        // BCD[6] SIM card number
  channelNumber: number;
  dataType: number;       // 4 bits: 0=I-frame, 1=P-frame, 2=B-frame, 3=Audio, 4=Transparent
  subpackageFlag: JTT1078SubpackageFlag;
  timestamp?: bigint;     // 8 bytes milliseconds (not present for transparent data)
  lastIFrameInterval?: number;  // WORD, only for video frames
  lastFrameInterval?: number;   // WORD, only for video frames
  payloadLength: number;
}

export enum JTT1078DataType {
  VIDEO_I_FRAME = 0x00,
  VIDEO_P_FRAME = 0x01,
  VIDEO_B_FRAME = 0x02,
  AUDIO_FRAME = 0x03,
  TRANSPARENT_DATA = 0x04
}

export interface Vehicle {
  id: string;
  phone: string;
  connected: boolean;
  lastHeartbeat: Date;
  activeStreams: Set<number>;
  channels?: VehicleChannel[];
}

export interface VehicleChannel {
  physicalChannel: number;
  logicalChannel: number;
  type: 'audio' | 'video' | 'audio_video';
  hasGimbal: boolean;
}

export interface StreamInfo {
  vehicleId: string;
  channel: number;
  active: boolean;
  frameCount: number;
  lastFrame: Date | null;
}

// Alert Types
export enum VideoAlarmType {
  VIDEO_SIGNAL_LOSS = 0x0101,
  VIDEO_SIGNAL_BLOCKING = 0x0102,
  STORAGE_FAILURE = 0x0103,
  OTHER_VIDEO_FAILURE = 0x0104,
  BUS_OVERCROWDING = 0x0105,
  ABNORMAL_DRIVING = 0x0106,
  SPECIAL_ALARM_THRESHOLD = 0x0107
}

export interface AbnormalDrivingBehavior {
  fatigue: boolean;
  phoneCall: boolean;
  smoking: boolean;
  custom: number; // bits 11-15
  fatigueLevel: number; // 0-100
}

export interface VideoAlarmStatus {
  videoSignalLoss: boolean;
  videoSignalBlocking: boolean;
  storageFailure: boolean;
  otherVideoFailure: boolean;
  busOvercrowding: boolean;
  abnormalDriving: boolean;
  specialAlarmThreshold: boolean;
  setBits?: number[]; // all set bits from 0x14 DWORD for auditability
}

export interface VendorAdditionalInfoExtension {
  infoId: number;
  rawHex: string;
  detectedCodes: number[];
  domain: 'ADAS' | 'DMS' | 'UNKNOWN';
  alarmId?: number;
  flagStatus?: number;
  eventType?: number;
  alarmLevel?: number;
  sourceSpeed?: number;
  sourceAltitude?: number;
  sourceLatitude?: number;
  sourceLongitude?: number;
  sourceTimestamp?: Date;
  vehicleStatus?: number;
  frontObjectSpeed?: number;
  frontObjectDistance?: number;
  deviationType?: number;
  roadSignType?: number;
  roadSignData?: number;
  identification?: {
    terminalId?: string;
    timestamp?: Date;
    sequenceNumber?: number;
    attachmentCount?: number;
    reserved?: number;
  };
}

export interface AlarmFlags {
  emergency: boolean;
  overspeed: boolean;
  fatigue: boolean;
  dangerousDriving: boolean;
  gnssModuleFailure: boolean;
  gnssAntennaDisconnected: boolean;
  gnssAntennaShortCircuit: boolean;
  terminalPowerUndervoltage: boolean;
  terminalPowerFailure: boolean;
  terminalDisplayFailure: boolean;
  ttsModuleFailure: boolean;
  cameraFailure: boolean;
  transportIcCardModuleFailure: boolean;
  overspeedWarning: boolean;
  fatigueWarning: boolean;
  vibrationAlarm: boolean;
  lightAlarm: boolean;
  magneticInductiveAlarm: boolean;
  accumulatedDrivingTimeAlarm: boolean;
  overtimeParking: boolean;
  areaEntryExitAlarm: boolean;
  routeEntryExitAlarm: boolean;
  routeTravelTimeAlarm: boolean;
  routeDeviationAlarm: boolean;
  vssFailure: boolean;
  abnormalFuelCapacity: boolean;
  vehicleTheft: boolean;
  illegalIgnition: boolean;
  illegalDisplacement: boolean;
  collisionWarning: boolean;
  rolloverWarning: boolean;
  illegalDoorOpenAlarm: boolean;
}

export interface LocationStatusFlags {
  accOn: boolean;
  positioned: boolean;
  southLatitude: boolean;
  westLongitude: boolean;
  outOfService: boolean;
  encrypted: boolean;
  loadStatus: 0 | 1 | 2 | 3;
  oilDisconnected: boolean;
  circuitDisconnected: boolean;
  doorLocked: boolean;
  door1Open: boolean;
  door2Open: boolean;
  door3Open: boolean;
  door4Open: boolean;
  door5Open: boolean;
  gpsPositioning: boolean;
  beidouPositioning: boolean;
  glonassPositioning: boolean;
  galileoPositioning: boolean;
}

export interface ExtendedVehicleSignalStatus {
  lowBeam: boolean;
  highBeam: boolean;
  rightTurn: boolean;
  leftTurn: boolean;
  brake: boolean;
  reverse: boolean;
  fogLight: boolean;
  clearanceLight: boolean;
  horn: boolean;
  airConditioning: boolean;
  neutral: boolean;
  retarderWorking: boolean;
  absWorking: boolean;
  heaterWorking: boolean;
  clutchEngaged: boolean;
  setBits?: number[];
}

export interface IoStatusFlags {
  deepSleep: boolean;
  sleep: boolean;
  setBits?: number[];
}

export interface OverspeedAdditionalInfo {
  locationType: number;
  areaOrRouteId?: number;
}

export interface AreaRouteAdditionalInfo {
  locationType: number;
  areaOrRouteId: number;
  direction: 0 | 1;
}

export interface RouteTravelTimeAdditionalInfo {
  routeId: number;
  travelTimeSeconds: number;
  result: 0 | 1;
}

export interface AnalogSignalStatus {
  ad0: number;
  ad1: number;
}

export interface AdditionalInfoItem {
  infoId: number;
  length: number;
  rawHex: string;
}

export interface LocationAlert {
  vehicleId: string;
  timestamp: Date;
  latitude: number;
  longitude: number;
  speed?: number;        // km/h from location report
  direction?: number;    // degrees
  altitude?: number;     // meters
  videoAlarms?: VideoAlarmStatus;
  alarmFlags?: AlarmFlags; // JT/T 808 base alarm flag DWORD
  alarmFlagSetBits?: number[]; // all set bits from JT/T 808 alarm DWORD
  rawAlarmFlag?: number;
  rawStatusFlag?: number;
  statusFlagSetBits?: number[];
  statusFlags?: LocationStatusFlags;
  mileageKm?: number;
  fuelLiters?: number;
  recordedSpeed?: number;
  extendedVehicleSignals?: ExtendedVehicleSignalStatus;
  ioStatus?: IoStatusFlags;
  manualConfirmAlarmEventId?: number;
  overspeedAdditionalInfo?: OverspeedAdditionalInfo;
  areaRouteAdditionalInfo?: AreaRouteAdditionalInfo;
  routeTravelTimeAdditionalInfo?: RouteTravelTimeAdditionalInfo;
  analogSignals?: AnalogSignalStatus;
  wirelessSignalStrength?: number;
  gnssSatelliteCount?: number;
  additionalInfoItems?: AdditionalInfoItem[];
  signalLossChannels?: number[]; // channels 1-32
  blockingChannels?: number[]; // channels 1-32
  memoryFailures?: { main: number[]; backup: number[]; };
  drivingBehavior?: AbnormalDrivingBehavior;
  vendorExtensions?: VendorAdditionalInfoExtension[];
}
