import { strict as assert } from 'assert';
import { JTT808Server } from '../tcp/server';
import { AlertManager, AlertPriority } from '../alerts/alertManager';
import { getVendorAlarmByCode, getVendorAlarmBySignalCode, getVendorAlarmByStructuredEvent } from '../protocol/vendorAlarmCatalog';

const run = () => {
  process.env.ALERT_MODE = 'strict';

  const server = new JTT808Server(0, 0) as any;
  const alertManager = new AlertManager() as any;

  // 1) Deterministic code mapping exists and priority is conservative.
  const mapped10102 = server.mapVendorAlarmCode(10102, { allowPlatformVideoCodes: true });
  assert(mapped10102, 'Expected code 10102 to map');
  assert.equal(mapped10102.signalCode, 'dms_10102_handheld_phone_alarm');
  assert.equal(mapped10102.priority, AlertPriority.HIGH);

  // 2) Non-whitelisted pass-through type should be ignored in strict mode.
  const blocked = server.extractPassThroughAlarms(
    0x30,
    Buffer.from('10102', 'ascii'),
    '10102',
    false,
    'pass_through'
  );
  assert.equal(blocked.length, 0, 'Expected strict mode to ignore non-whitelisted pass-through type');

  // 3) Text phrase without numeric code should not emit alert in strict mode.
  const phraseOnly = server.mapVendorAlarmsFromBytes(
    Buffer.from('DMS: receive handheld phone alarm', 'ascii'),
    true,
    { strictMode: true, extractionMethod: 'ascii_code', requireDeterministic: true }
  );
  assert.equal(phraseOnly.length, 0, 'Expected no alert from phrase-only payload');

  // 4) Duplicate deterministic mapping paths should dedupe to a single alert.
  // For pass-through type 0xA1, compact decoder + first WORD decoder can resolve same 0x0101.
  const duplicate = server.extractPassThroughAlarms(
    0xA1,
    Buffer.from([0x01, 0x01, 0x00, 0x00]),
    '',
    true,
    'pass_through'
  );
  assert.equal(duplicate.length, 1, 'Expected duplicate code dedupe');
  assert.equal(duplicate[0].signalCode, 'platform_video_alarm_0101');

  // 5) Catalog and signal labeling must be consistent.
  const catalogSignal = getVendorAlarmBySignalCode('dms_10102_handheld_phone_alarm');
  const detail = alertManager.getSignalDetail('dms_10102_handheld_phone_alarm');
  assert(catalogSignal, 'Expected catalog lookup by signal code');
  assert.equal(detail.label, catalogSignal.type);

  // 6) Canonical catalog has all expected sample codes.
  const expectedCodes = [10001, 10017, 10101, 10117, 11201, 11203];
  for (const code of expectedCodes) {
    assert(getVendorAlarmByCode(code), `Expected catalog code ${code}`);
  }

  // 7) Structured 0x64/0x65 event types map onto named vendor alerts.
  assert.equal(
    getVendorAlarmByStructuredEvent('ADAS', 1)?.signalCode,
    'adas_10001_forward_collision_warning'
  );
  assert.equal(
    getVendorAlarmByStructuredEvent('DMS', 2)?.signalCode,
    'dms_10102_handheld_phone_alarm'
  );

  console.log('vendor-alert-conformance: ok');
};

run();
