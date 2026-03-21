-- Application schema bootstrap for video_system.
-- Run after bootstrap_cluster.sql, for example:
--   sudo -u postgres psql -d video_system -f postgres/bootstrap_schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  ip_address TEXT,
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  channel INTEGER NOT NULL,
  alert_type TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'escalated', 'resolved')),
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_level INTEGER DEFAULT 0,
  timestamp TIMESTAMPTZ NOT NULL,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  metadata JSONB,
  closure_type TEXT,
  closure_subtype TEXT,
  resolution_notes TEXT,
  resolved_by TEXT,
  resolution_reason_code TEXT,
  resolution_reason_label TEXT,
  ncr_document_url TEXT,
  ncr_document_name TEXT,
  report_document_url TEXT,
  report_document_name TEXT,
  report_document_type TEXT,
  is_false_alert BOOLEAN NOT NULL DEFAULT FALSE,
  false_alert_reason TEXT,
  false_alert_reason_code TEXT,
  repeated_count INTEGER DEFAULT 1,
  last_occurrence TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  channel INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT,
  storage_url TEXT,
  alert_id TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  channel INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT,
  storage_url TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration_seconds INTEGER,
  frame_count INTEGER,
  video_type TEXT NOT NULL CHECK (video_type IN ('live', 'alert_pre', 'alert_post', 'camera_sd', 'manual')),
  alert_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS protocol_messages (
  id BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  direction TEXT NOT NULL DEFAULT 'inbound',
  vehicle_id TEXT NOT NULL,
  message_id INTEGER,
  message_id_hex TEXT,
  serial_number INTEGER NOT NULL DEFAULT 0,
  body_length INTEGER NOT NULL DEFAULT 0,
  is_subpackage BOOLEAN NOT NULL DEFAULT FALSE,
  packet_count INTEGER,
  packet_index INTEGER,
  raw_frame_hex TEXT NOT NULL,
  body_hex TEXT NOT NULL,
  body_text_preview TEXT,
  parse_success BOOLEAN,
  parse_error TEXT,
  parse JSONB
);

CREATE INDEX IF NOT EXISTS idx_alerts_device_time ON alerts(device_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status) WHERE status != 'resolved';
CREATE INDEX IF NOT EXISTS idx_alerts_resolved_bool ON alerts(resolved);
CREATE INDEX IF NOT EXISTS idx_alerts_closure_type ON alerts(closure_type);
CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(device_id, channel, alert_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_alert_id ON images(alert_id);
CREATE INDEX IF NOT EXISTS idx_images_device_timestamp ON images(device_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_videos_alert_id ON videos(alert_id);
CREATE INDEX IF NOT EXISTS idx_videos_device_start_time ON videos(device_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_videos_device_channel_start_time ON videos(device_id, channel, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_videos_device_channel_end_time ON videos(device_id, channel, end_time DESC);
CREATE INDEX IF NOT EXISTS idx_protocol_messages_received_at ON protocol_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_protocol_messages_message_id_received_at ON protocol_messages(message_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_protocol_messages_vehicle_received_at ON protocol_messages(vehicle_id, received_at DESC);
