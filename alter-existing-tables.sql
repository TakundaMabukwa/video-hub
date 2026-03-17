-- JT/T 1078 Video System
-- Existing database migration for already-created tables
-- Safe to run multiple times.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================
-- ALERTS
-- ============================================
ALTER TABLE IF EXISTS alerts
  ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS closure_type TEXT,
  ADD COLUMN IF NOT EXISTS closure_subtype TEXT,
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by TEXT,
  ADD COLUMN IF NOT EXISTS resolution_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS resolution_reason_label TEXT,
  ADD COLUMN IF NOT EXISTS ncr_document_url TEXT,
  ADD COLUMN IF NOT EXISTS ncr_document_name TEXT,
  ADD COLUMN IF NOT EXISTS report_document_url TEXT,
  ADD COLUMN IF NOT EXISTS report_document_name TEXT,
  ADD COLUMN IF NOT EXISTS report_document_type TEXT,
  ADD COLUMN IF NOT EXISTS is_false_alert BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS false_alert_reason TEXT,
  ADD COLUMN IF NOT EXISTS false_alert_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS repeated_count INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_occurrence TIMESTAMP DEFAULT NOW();

-- ============================================
-- IMAGES
-- ============================================
ALTER TABLE IF EXISTS images
  ADD COLUMN IF NOT EXISTS storage_url TEXT,
  ADD COLUMN IF NOT EXISTS file_size BIGINT,
  ADD COLUMN IF NOT EXISTS alert_id TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'alerts'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'images'
  ) THEN
    BEGIN
      ALTER TABLE images
        ADD CONSTRAINT images_alert_id_fkey
        FOREIGN KEY (alert_id)
        REFERENCES alerts(id)
        ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ============================================
-- VIDEOS
-- ============================================
ALTER TABLE IF EXISTS videos
  ADD COLUMN IF NOT EXISTS storage_url TEXT,
  ADD COLUMN IF NOT EXISTS alert_id TEXT,
  ADD COLUMN IF NOT EXISTS frame_count INTEGER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'videos'
      AND constraint_name = 'videos_video_type_check'
  ) THEN
    ALTER TABLE videos DROP CONSTRAINT videos_video_type_check;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'videos'
  ) THEN
    ALTER TABLE videos
      ADD CONSTRAINT videos_video_type_check
      CHECK (video_type IN ('live', 'alert_pre', 'alert_post', 'camera_sd', 'manual'));
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_images_alert_id
  ON images(alert_id);

CREATE INDEX IF NOT EXISTS idx_images_device_timestamp
  ON images(device_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_videos_alert_id
  ON videos(alert_id);

CREATE INDEX IF NOT EXISTS idx_videos_device_start_time
  ON videos(device_id, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_videos_device_channel_start_time
  ON videos(device_id, channel, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_videos_device_channel_end_time
  ON videos(device_id, channel, end_time DESC);

COMMIT;
