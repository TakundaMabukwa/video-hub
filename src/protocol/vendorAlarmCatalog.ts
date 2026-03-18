export type VendorAlarmDomain = 'PLATFORM_VIDEO' | 'ADAS' | 'DMS' | 'BEHAVIOR';
export type VendorAlarmPriority = 'low' | 'medium' | 'high' | 'critical';

export type VendorAlarmEntry = {
  code: number;
  type: string;
  signalCode: string;
  domain: VendorAlarmDomain;
  defaultPriority: VendorAlarmPriority;
  meaning: string;
  sourceRef: string;
};

const BASE_VENDOR_ALARM_CATALOG: VendorAlarmEntry[] = [
  {
    code: 0x0101,
    type: 'Video Signal Loss',
    signalCode: 'platform_video_alarm_0101',
    domain: 'PLATFORM_VIDEO',
    defaultPriority: 'medium',
    meaning: 'Platform-level video alarm code 0x0101 reported.',
    sourceRef: 'JT/T 1078 Table 38'
  },
  {
    code: 0x0102,
    type: 'Video Signal Blocking',
    signalCode: 'platform_video_alarm_0102',
    domain: 'PLATFORM_VIDEO',
    defaultPriority: 'medium',
    meaning: 'Platform-level video alarm code 0x0102 reported.',
    sourceRef: 'JT/T 1078 Table 38'
  },
  {
    code: 0x0103,
    type: 'Storage Unit Failure',
    signalCode: 'platform_video_alarm_0103',
    domain: 'PLATFORM_VIDEO',
    defaultPriority: 'medium',
    meaning: 'Platform-level video alarm code 0x0103 reported.',
    sourceRef: 'JT/T 1078 Table 38'
  },
  {
    code: 0x0104,
    type: 'Other Video Equipment Failure',
    signalCode: 'platform_video_alarm_0104',
    domain: 'PLATFORM_VIDEO',
    defaultPriority: 'medium',
    meaning: 'Platform-level video alarm code 0x0104 reported.',
    sourceRef: 'JT/T 1078 Table 38'
  },
  {
    code: 0x0105,
    type: 'Bus Overcrowding',
    signalCode: 'platform_video_alarm_0105',
    domain: 'PLATFORM_VIDEO',
    defaultPriority: 'medium',
    meaning: 'Platform-level video alarm code 0x0105 reported.',
    sourceRef: 'JT/T 1078 Table 38'
  },
  {
    code: 0x0106,
    type: 'Abnormal Driving Behavior',
    signalCode: 'platform_video_alarm_0106',
    domain: 'PLATFORM_VIDEO',
    defaultPriority: 'high',
    meaning: 'Platform-level video alarm code 0x0106 reported.',
    sourceRef: 'JT/T 1078 Table 38'
  },
  {
    code: 0x0107,
    type: 'Special Alarm Recording Threshold',
    signalCode: 'platform_video_alarm_0107',
    domain: 'PLATFORM_VIDEO',
    defaultPriority: 'medium',
    meaning: 'Platform-level video alarm code 0x0107 reported.',
    sourceRef: 'JT/T 1078 Table 38'
  },
  {
    code: 10001,
    type: 'ADAS: Forward collision warning',
    signalCode: 'adas_10001_forward_collision_warning',
    domain: 'ADAS',
    defaultPriority: 'critical',
    meaning: 'Forward collision warning event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10002,
    type: 'ADAS: Lane departure alarm',
    signalCode: 'adas_10002_lane_departure_alarm',
    domain: 'ADAS',
    defaultPriority: 'high',
    meaning: 'Lane departure event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10003,
    type: 'ADAS: Following distance too close',
    signalCode: 'adas_10003_following_distance_too_close',
    domain: 'ADAS',
    defaultPriority: 'high',
    meaning: 'Following distance too close event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10004,
    type: 'ADAS: Pedestrian collision alarm',
    signalCode: 'adas_10004_pedestrian_collision_alarm',
    domain: 'ADAS',
    defaultPriority: 'critical',
    meaning: 'Pedestrian collision warning event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10005,
    type: 'ADAS: Frequent lane change alarm',
    signalCode: 'adas_10005_frequent_lane_change_alarm',
    domain: 'ADAS',
    defaultPriority: 'high',
    meaning: 'Frequent lane change event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10006,
    type: 'ADAS: Road sign over-limit alarm',
    signalCode: 'adas_10006_road_sign_over_limit_alarm',
    domain: 'ADAS',
    defaultPriority: 'medium',
    meaning: 'Road sign over-limit event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10007,
    type: 'ADAS: Obstruction alarm',
    signalCode: 'adas_10007_obstruction_alarm',
    domain: 'ADAS',
    defaultPriority: 'medium',
    meaning: 'Obstruction event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10008,
    type: 'ADAS: Driver assistance function failure alarm',
    signalCode: 'adas_10008_driver_assist_function_failure',
    domain: 'ADAS',
    defaultPriority: 'medium',
    meaning: 'Driver assistance function failure event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10016,
    type: 'ADAS: Road sign identification event',
    signalCode: 'adas_10016_road_sign_identification_event',
    domain: 'ADAS',
    defaultPriority: 'low',
    meaning: 'Road sign identification event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10017,
    type: 'ADAS: Active capture event',
    signalCode: 'adas_10017_active_capture_event',
    domain: 'ADAS',
    defaultPriority: 'low',
    meaning: 'Active capture event reported by ADAS.',
    sourceRef: 'Vendor ADAS code list'
  },
  {
    code: 10101,
    type: 'DMS: Fatigue driving alarm',
    signalCode: 'dms_10101_fatigue_driving_alarm',
    domain: 'DMS',
    defaultPriority: 'high',
    meaning: 'Fatigue driving event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10102,
    type: 'DMS: Handheld phone alarm',
    signalCode: 'dms_10102_handheld_phone_alarm',
    domain: 'DMS',
    defaultPriority: 'high',
    meaning: 'Handheld phone usage event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10103,
    type: 'DMS: Smoking alarm',
    signalCode: 'dms_10103_smoking_alarm',
    domain: 'DMS',
    defaultPriority: 'high',
    meaning: 'Smoking event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10104,
    type: 'DMS: Forward camera invisible too long',
    signalCode: 'dms_10104_forward_invisible_too_long',
    domain: 'DMS',
    defaultPriority: 'medium',
    meaning: 'Forward camera invisible too long event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10105,
    type: 'DMS: Driver alarm not detected',
    signalCode: 'dms_10105_driver_alarm_not_detected',
    domain: 'DMS',
    defaultPriority: 'medium',
    meaning: 'Driver alarm not detected event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10106,
    type: 'DMS: Both hands off steering wheel',
    signalCode: 'dms_10106_hands_off_steering',
    domain: 'DMS',
    defaultPriority: 'high',
    meaning: 'Both hands off steering wheel event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10107,
    type: 'DMS: Driver behavior monitoring failure',
    signalCode: 'dms_10107_behavior_monitoring_failure',
    domain: 'DMS',
    defaultPriority: 'medium',
    meaning: 'Driver behavior monitoring function failure event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10116,
    type: 'DMS: Automatic capture event',
    signalCode: 'dms_10116_automatic_capture_event',
    domain: 'DMS',
    defaultPriority: 'low',
    meaning: 'Automatic capture event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 10117,
    type: 'DMS: Driver change',
    signalCode: 'dms_10117_driver_change',
    domain: 'DMS',
    defaultPriority: 'low',
    meaning: 'Driver change event reported by DMS.',
    sourceRef: 'Vendor DMS code list'
  },
  {
    code: 11201,
    type: 'Rapid acceleration',
    signalCode: 'behavior_11201_rapid_acceleration',
    domain: 'BEHAVIOR',
    defaultPriority: 'medium',
    meaning: 'Rapid acceleration event reported by behavior analysis.',
    sourceRef: 'Vendor behavior code list'
  },
  {
    code: 11202,
    type: 'Rapid deceleration',
    signalCode: 'behavior_11202_rapid_deceleration',
    domain: 'BEHAVIOR',
    defaultPriority: 'medium',
    meaning: 'Rapid deceleration event reported by behavior analysis.',
    sourceRef: 'Vendor behavior code list'
  },
  {
    code: 11203,
    type: 'Sharp turn',
    signalCode: 'behavior_11203_sharp_turn',
    domain: 'BEHAVIOR',
    defaultPriority: 'medium',
    meaning: 'Sharp turn event reported by behavior analysis.',
    sourceRef: 'Vendor behavior code list'
  }
];

const parsePriority = (value: string): VendorAlarmPriority | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low') return 'low';
  if (normalized === 'medium') return 'medium';
  if (normalized === 'high') return 'high';
  if (normalized === 'critical') return 'critical';
  return null;
};

const parsePriorityOverrides = (): Map<number, VendorAlarmPriority> => {
  const raw = String(process.env.VENDOR_ALARM_PRIORITY_OVERRIDES || '').trim();
  const out = new Map<number, VendorAlarmPriority>();
  if (!raw) return out;

  for (const token of raw.split(',')) {
    const item = token.trim();
    if (!item) continue;
    const [codeRaw, prRaw] = item.split(':').map((v) => v.trim());
    if (!codeRaw || !prRaw) continue;
    const code = codeRaw.toLowerCase().startsWith('0x')
      ? parseInt(codeRaw, 16)
      : parseInt(codeRaw, 10);
    const pr = parsePriority(prRaw);
    if (!Number.isFinite(code) || !pr) continue;
    out.set(code, pr);
  }
  return out;
};

const priorityOverrides = parsePriorityOverrides();

export const getVendorAlarmCatalog = (): VendorAlarmEntry[] => {
  return BASE_VENDOR_ALARM_CATALOG.map((item) => ({
    ...item,
    defaultPriority: priorityOverrides.get(item.code) || item.defaultPriority
  }));
};

export const getVendorAlarmByCode = (
  code: number,
  options?: { allowPlatformVideoCodes?: boolean }
): VendorAlarmEntry | null => {
  const allowPlatformVideoCodes = options?.allowPlatformVideoCodes ?? true;
  const match = getVendorAlarmCatalog().find((item) => item.code === code) || null;
  if (!match) return null;
  if (!allowPlatformVideoCodes && match.domain === 'PLATFORM_VIDEO') return null;
  return match;
};

export const getVendorAlarmBySignalCode = (signalCode: string): VendorAlarmEntry | null => {
  return getVendorAlarmCatalog().find((item) => item.signalCode === signalCode) || null;
};

export const getKnownVendorCodes = (): Set<number> => {
  return new Set<number>(getVendorAlarmCatalog().map((item) => item.code));
};

const STRUCTURED_ACTIVE_SAFETY_EVENT_CODE_MAP: Record<'ADAS' | 'DMS', Record<number, number>> = {
  ADAS: {
    1: 10001,
    2: 10002,
    3: 10003,
    4: 10004,
    5: 10005,
    6: 10006,
    7: 10007,
    8: 10008,
    16: 10016,
    17: 10017
  },
  DMS: {
    1: 10101,
    2: 10102,
    3: 10103,
    4: 10104,
    5: 10105,
    6: 10106,
    7: 10107,
    16: 10116,
    17: 10117
  }
};

export const getVendorAlarmByStructuredEvent = (
  domain: 'ADAS' | 'DMS',
  eventType: number
): VendorAlarmEntry | null => {
  const code = STRUCTURED_ACTIVE_SAFETY_EVENT_CODE_MAP[domain]?.[eventType];
  if (!Number.isFinite(code)) return null;
  return getVendorAlarmByCode(code, { allowPlatformVideoCodes: false });
};
