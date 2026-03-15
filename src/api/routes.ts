import express from 'express';
import { JTT808Server } from '../tcp/server';
import { UDPRTPServer } from '../udp/server';
import { SpeedingManager } from '../services/speedingManager';
import { VideoStorage } from '../storage/videoStorage';
import { ImageStorage } from '../storage/imageStorage';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { query as dbQuery } from '../storage/database';
import { archiveToRawH264 } from '../video/frameArchive';
import { ReplayService } from '../streaming/replay';

export function createRoutes(
  tcpServer: JTT808Server,
  udpServer: UDPRTPServer,
  replayService?: ReplayService
): express.Router {
  const router = express.Router();
  const FTP_DOWNLOADS_ENABLED = false;
  const speedingManager = new SpeedingManager();
  const videoStorage = new VideoStorage();
  const imageStorage = new ImageStorage();
  const manualVideoJobs = new Map<string, {
    id: string;
    vehicleId: string;
    channel: number;
    startTime: string;
    endTime: string;
    alertId?: string;
    windowType?: 'pre' | 'post';
    status: 'queued' | 'running' | 'completed' | 'failed';
    createdAt: string;
    updatedAt: string;
    outputPath?: string;
    outputUrl?: string;
    persistedVideoId?: string;
    persistedVideoUrl?: string;
    error?: string;
  }>();
  const queuedAlertWindows = new Set<string>();
  const alertEnsureState = new Map<string, number>();
  const ALERT_ENSURE_COOLDOWN_MS = Math.max(5000, Number(process.env.ALERT_MEDIA_ENSURE_COOLDOWN_MS || 10000));
  const getVehicleChannels = (vehicleId: string, preferredChannel: number): number[] => {
    const vehicle = tcpServer.getVehicle(vehicleId);
    const fromCaps = Array.isArray(vehicle?.channels)
      ? vehicle!.channels
          .filter((ch: any) => ch.type === 'video' || ch.type === 'audio_video')
          .map((ch: any) => Number(ch.logicalChannel))
          .filter((ch: number) => Number.isFinite(ch) && ch > 0)
      : [];
    const fromActive = Array.from(vehicle?.activeStreams || [])
      .map((ch) => Number(ch))
      .filter((ch) => Number.isFinite(ch) && ch > 0);
    const p = Number(preferredChannel);
    const ordered: number[] = [];
    const pushIf = (value: number) => {
      if (!Number.isFinite(value) || value <= 0 || ordered.includes(value)) return;
      ordered.push(value);
    };
    if (Number.isFinite(p) && p > 0) pushIf(p);
    fromCaps.forEach(pushIf);
    fromActive.forEach(pushIf);
    pushIf(1);
    pushIf(2);
    return ordered;
  };
  const ensureAlertMediaRequested = async (
    alertId: string,
    vehicleId: string,
    channel: number,
    alertTimestamp: Date,
    options?: { ensureScreenshots?: boolean; ensureVideo?: boolean }
  ) => {
    const now = Date.now();
    const key = `${alertId}`;
    const last = alertEnsureState.get(key) || 0;
    if (now - last < ALERT_ENSURE_COOLDOWN_MS) {
      return { started: false, reason: 'cooldown' };
    }
    alertEnsureState.set(key, now);

    const ensureScreenshots = options?.ensureScreenshots !== false;
    const ensureVideo = options?.ensureVideo !== false;
    const channels = getVehicleChannels(vehicleId, channel);
    const screenshotRequests: Array<Promise<any>> = [];

    if (ensureScreenshots) {
      for (const ch of channels) {
        screenshotRequests.push(
          tcpServer.requestScreenshotWithFallback(vehicleId, ch, {
            fallback: true,
            fallbackDelayMs: 600,
            alertId,
            captureVideoEvidence: true,
            videoDurationSec: 8
          })
        );
      }
    }

    let videoScheduled = false;
    if (ensureVideo) {
      const start = new Date(alertTimestamp.getTime() - 30 * 1000);
      const end = new Date(alertTimestamp.getTime() + 30 * 1000);
      for (const ch of channels) {
        const scheduled = tcpServer.scheduleCameraReportRequests(vehicleId, ch, start, end, {
          queryResources: true,
          requestDownload: false
        });
        videoScheduled = videoScheduled || scheduled.requested || scheduled.queued;
      }
    }

    if (screenshotRequests.length) {
      await Promise.allSettled(screenshotRequests);
    }

    return { started: true, videoScheduled, channels };
  };
  const buildAlertMediaLinks = (alertId: string) => {
    const id = encodeURIComponent(String(alertId));
    return {
      alert: `/api/alerts/${id}`,
      media: `/api/alerts/${id}/media`,
      screenshots: `/api/alerts/${id}/screenshots`,
      videos: `/api/alerts/${id}/videos`,
      preVideo: `/api/alerts/${id}/video/pre`,
      postVideo: `/api/alerts/${id}/video/post`,
      requestReportVideo: `/api/alerts/${id}/request-report-video`,
      collectEvidence: `/api/alerts/${id}/collect-evidence`
    };
  };
  const withAlertMediaLinks = (alert: any) => ({
    ...alert,
    mediaLinks: buildAlertMediaLinks(alert.id)
  });
  const loadAlertRow = async (alertId: string): Promise<any | null> => {
    const db = require('../storage/database');
    const result = await db.query(
      `SELECT id, device_id, channel, alert_type, priority, status, resolved, timestamp, latitude, longitude, metadata,
              resolution_notes, resolved_by, resolved_at,
              closure_type, closure_subtype,
              resolution_reason_code, resolution_reason_label,
              ncr_document_url, ncr_document_name,
              report_document_url, report_document_name, report_document_type,
              is_false_alert, false_alert_reason, false_alert_reason_code
       FROM alerts
       WHERE id = $1`,
      [alertId]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  };
  const parseAlertMetadata = (raw: any) => {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    }
    return raw;
  };
  const extractNativeSignalsFromParsedAlert = (parsedAlert: any): string[] => {
    if (!parsedAlert || typeof parsedAlert !== 'object') return [];
    const signals: string[] = [];
    const alarmFlags = parsedAlert.alarmFlags || {};
    if (alarmFlags.emergency) signals.push('jt808_emergency');
    if (alarmFlags.overspeed) signals.push('jt808_overspeed');
    if (alarmFlags.fatigue) signals.push('jt808_fatigue');
    if (alarmFlags.dangerousDriving) signals.push('jt808_dangerous_driving');
    if (alarmFlags.overspeedWarning) signals.push('jt808_overspeed_warning');
    if (alarmFlags.fatigueWarning) signals.push('jt808_fatigue_warning');
    if (alarmFlags.collisionWarning) signals.push('jt808_collision_warning');
    if (alarmFlags.rolloverWarning) signals.push('jt808_rollover_warning');

    const videoAlarms = parsedAlert.videoAlarms || {};
    if (videoAlarms.videoSignalLoss) signals.push('jtt1078_video_signal_loss');
    if (videoAlarms.videoSignalBlocking) signals.push('jtt1078_video_signal_blocking');
    if (videoAlarms.storageFailure) signals.push('jtt1078_storage_failure');
    if (videoAlarms.otherVideoFailure) signals.push('jtt1078_other_video_failure');
    if (videoAlarms.busOvercrowding) signals.push('jtt1078_bus_overcrowding');
    if (videoAlarms.abnormalDriving) signals.push('jtt1078_abnormal_driving');
    if (videoAlarms.specialAlarmThreshold) signals.push('jtt1078_special_alarm_threshold');
    if (Array.isArray(videoAlarms.setBits)) {
      for (const bit of videoAlarms.setBits) {
        if (Number(bit) > 6) signals.push(`jtt1078_video_alarm_bit_${bit}`);
      }
    }

    if (Array.isArray(parsedAlert.signalLossChannels) && parsedAlert.signalLossChannels.length) {
      signals.push(`jtt1078_signal_loss_channels_${parsedAlert.signalLossChannels.join('_')}`);
    }
    if (Array.isArray(parsedAlert.blockingChannels) && parsedAlert.blockingChannels.length) {
      signals.push(`jtt1078_signal_blocking_channels_${parsedAlert.blockingChannels.join('_')}`);
    }
    if (
      parsedAlert.memoryFailures &&
      ((Array.isArray(parsedAlert.memoryFailures.main) && parsedAlert.memoryFailures.main.length) ||
        (Array.isArray(parsedAlert.memoryFailures.backup) && parsedAlert.memoryFailures.backup.length))
    ) {
      signals.push('jtt1078_memory_failure');
    }

    const drivingBehavior = parsedAlert.drivingBehavior || {};
    if (drivingBehavior.fatigue) signals.push('jtt1078_behavior_fatigue');
    if (drivingBehavior.phoneCall) signals.push('jtt1078_behavior_phone_call');
    if (drivingBehavior.smoking) signals.push('jtt1078_behavior_smoking');
    if (Number(drivingBehavior.custom || 0) > 0) signals.push(`jtt1078_behavior_custom_${drivingBehavior.custom}`);

    return Array.from(new Set(signals));
  };
  const classifyTraceSourceShape = (trace: any, parse: any): string => {
    const messageIdHex = String(trace?.messageIdHex || '').toLowerCase();
    const additionalInfo = Array.isArray(parse?.additionalInfo) ? parse.additionalInfo : [];
    const itemDiagnostics = Array.isArray(parse?.itemDiagnostics) ? parse.itemDiagnostics : [];
    const locationInfoIds = new Set<number>();

    for (const item of additionalInfo) {
      const id = Number(item?.idDec);
      if (Number.isFinite(id)) locationInfoIds.add(id);
    }
    for (const batchItem of itemDiagnostics) {
      const fields = Array.isArray(batchItem?.additionalInfo) ? batchItem.additionalInfo : [];
      for (const item of fields) {
        const id = Number(item?.idDec);
        if (Number.isFinite(id)) locationInfoIds.add(id);
      }
    }

    const hasVideoRelatedAlertInfo = [0x14, 0x15, 0x16, 0x17, 0x18].some((id) => locationInfoIds.has(id));

    if (messageIdHex === '0x0200' || messageIdHex === '0x0704') {
      return hasVideoRelatedAlertInfo
        ? 'video-related-alerts'
        : 'location-report-with-additional-info';
    }
    if (messageIdHex === '0x0900') return 'pass-through';
    if (messageIdHex === '0x0800') return 'multimedia-event';
    if (messageIdHex === '0x0801') return 'multimedia-data';
    if (messageIdHex === '0x1205') return 'resource-list';
    return 'other';
  };
  const extractSignalsFromResourceList = (resourceList: any): string[] => {
    const items = Array.isArray(resourceList?.items) ? resourceList.items : [];
    const signals: string[] = [];
    for (const item of items) {
      const bits = Array.isArray(item?.alarmBits) ? item.alarmBits.map((v: any) => Number(v)).filter(Number.isFinite) : [];
      for (const bit of bits) {
        if (bit === 32) signals.push('jtt1078_video_signal_loss');
        else if (bit === 33) signals.push('jtt1078_video_signal_blocking');
        else if (bit === 34) signals.push('jtt1078_storage_failure');
        else if (bit === 35) signals.push('jtt1078_other_video_failure');
        else if (bit === 36) signals.push('jtt1078_bus_overcrowding');
        else if (bit === 37) signals.push('jtt1078_abnormal_driving');
        else if (bit === 38) signals.push('jtt1078_special_alarm_threshold');
        else if (bit > 38 && bit < 64) signals.push(`jtt1078_video_alarm_bit_${bit - 32}`);
      }
    }
    return Array.from(new Set(signals));
  };
  const backfillAlertMediaLinks = async (alertId: string, row: any) => {
    const deviceId = String(row?.device_id || '').trim();
    const channel = Number(row?.channel || 1);
    const alertTs = new Date(row?.timestamp);
    if (!deviceId || Number.isNaN(alertTs.getTime())) {
      return { screenshotsLinked: 0, videosLinked: 0 };
    }

    const linkWindowSeconds = Math.max(15, Math.min(300, Number(process.env.ALERT_MEDIA_LINK_WINDOW_SECONDS || 90)));
    const channelSpan = Math.max(0, Math.min(2, Number(process.env.ALERT_MEDIA_LINK_CHANNEL_SPAN || 1)));
    const from = new Date(alertTs.getTime() - linkWindowSeconds * 1000);
    const to = new Date(alertTs.getTime() + linkWindowSeconds * 1000);
    const vFrom = new Date(alertTs.getTime() - (linkWindowSeconds + 30) * 1000);
    const vTo = new Date(alertTs.getTime() + (linkWindowSeconds + 60) * 1000);

    const screenshotsRes = await dbQuery(
      `UPDATE images
       SET alert_id = $1
       WHERE alert_id IS NULL
         AND device_id = $2
         AND channel BETWEEN GREATEST($3::int - $4::int, 1) AND ($3::int + $4::int)
         AND timestamp BETWEEN $5::timestamp AND $6::timestamp`,
      [alertId, deviceId, channel, channelSpan, from, to]
    );

    const videosRes = await dbQuery(
      `UPDATE videos
       SET alert_id = $1
       WHERE alert_id IS NULL
         AND device_id = $2
         AND channel BETWEEN GREATEST($3::int - $4::int, 1) AND ($3::int + $4::int)
         AND start_time BETWEEN $5::timestamp AND $6::timestamp
         AND video_type IN ('alert_pre', 'alert_post', 'camera_sd', 'manual')`,
      [alertId, deviceId, channel, channelSpan, vFrom, vTo]
    );

    return {
      screenshotsLinked: Number(screenshotsRes.rowCount || 0),
      videosLinked: Number(videosRes.rowCount || 0)
    };
  };
  const parseResourceTime = (value: string): Date | null => {
    if (!value || typeof value !== 'string') return null;
    const isoLike = value.replace(' ', 'T');
    const d = new Date(isoLike);
    if (!Number.isNaN(d.getTime())) return d;
    const dUtc = new Date(`${isoLike}Z`);
    return Number.isNaN(dUtc.getTime()) ? null : dUtc;
  };
  const normalizePublicVideoUrl = (value: any, fallback: string) => {
    const s = String(value || '').trim();
    if (s && /^https?:\/\//i.test(s)) return s;
    if (s && s.startsWith('/api/')) return s;
    return fallback;
  };
  const buildStoredVideoUrl = (videoId: string) => `/api/videos/${encodeURIComponent(String(videoId))}/file`;
  const normalizePublicImageUrl = (img: any) => {
    const raw = String(img?.storage_url || '').trim();
    if (raw && /^https?:\/\//i.test(raw)) return raw;
    if (raw && raw.startsWith('/api/')) return raw;
    if (img?.id) return `/api/images/${encodeURIComponent(String(img.id))}/file`;
    return '';
  };
  const transcodeCache = new Map<string, Promise<string>>();

  const buildStreamUrl = (vehicleId: string, channel: number) =>
    `/api/stream/${encodeURIComponent(String(vehicleId))}/${encodeURIComponent(String(channel))}/playlist.m3u8`;

  const startLiveStreamForVehicle = (vehicleId: string, channel: number): boolean => {
    try {
      const started = tcpServer.startVideo(vehicleId, channel);
      if (started) {
        udpServer.startHLSStream(vehicleId, channel);
        return true;
      }
    } catch {}
    return false;
  };

  const queryStoredVideoSegments = async (vehicleId: string, channel: number, start: Date, end: Date) => {
    const db = require('../storage/database');
    const result = await db.query(
      `SELECT id, file_path, start_time, end_time, duration_seconds, frame_count, alert_id
       FROM videos
       WHERE device_id = $1
         AND channel = $2
         AND start_time <= $3
         AND COALESCE(end_time, start_time) >= $4
       ORDER BY start_time ASC`,
      [vehicleId, channel, end, start]
    );
    return (result.rows || [])
      .map((row: any) => ({
        ...row,
        file_path: String(row?.file_path || '').trim()
      }))
      .filter((row: any) => !!row.file_path);
  };
  const inferSegmentInputFps = (segment: {
    duration_seconds?: number | null;
    frame_count?: number | null;
  }) => {
    const durationSeconds = Number(segment?.duration_seconds || 0);
    const frameCount = Number(segment?.frame_count || 0);
    if (durationSeconds > 0 && frameCount > 0) {
      const fps = frameCount / durationSeconds;
      if (Number.isFinite(fps) && fps > 0) {
        return Math.max(0.2, Math.min(30, fps));
      }
    }
    const fallback = Number(process.env.VIDEO_DEFAULT_INPUT_FPS || 0);
    if (Number.isFinite(fallback) && fallback > 0) {
      return Math.max(0.2, Math.min(30, fallback));
    }
    return undefined;
  };
  const extractScreenshotFromStoredSegment = async (
    vehicleId: string,
    channel: number,
    alertId: string,
    captureAt: Date,
    segment: {
      id: string;
      file_path: string;
      start_time: string | Date;
      end_time?: string | Date | null;
      duration_seconds?: number | null;
    }
  ) => {
    const rawPath = String(segment?.file_path || '').trim();
    if (!rawPath) return null;
    const localPath = path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath);
    if (!fs.existsSync(localPath)) return null;

    const sourcePath = /\.mp4$/i.test(localPath) ? localPath : await toPlayableMp4(localPath, inferSegmentInputFps(segment));
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;

    const segmentStart = new Date(segment.start_time);
    const segmentEnd = segment.end_time ? new Date(segment.end_time) : null;
    const durationSeconds = Number(segment.duration_seconds || 0);
    const maxOffset = segmentEnd && !Number.isNaN(segmentEnd.getTime())
      ? Math.max(0, (segmentEnd.getTime() - segmentStart.getTime()) / 1000)
      : Math.max(0, durationSeconds);
    const rawOffset = Math.max(0, (captureAt.getTime() - segmentStart.getTime()) / 1000);
    const offsetSeconds = maxOffset > 0 ? Math.min(rawOffset, Math.max(0, maxOffset - 0.04)) : rawOffset;

    const imageData = await new Promise<Buffer | null>((resolve) => {
      const ffmpeg = spawn(getFfmpegBinary(), [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        offsetSeconds.toFixed(3),
        '-i',
        sourcePath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      const chunks: Buffer[] = [];
      let resolved = false;
      const finish = (buffer: Buffer | null) => {
        if (resolved) return;
        resolved = true;
        resolve(buffer);
      };
      const timeout = setTimeout(() => {
        try { ffmpeg.kill('SIGKILL'); } catch {}
        finish(null);
      }, 8000);

      ffmpeg.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
      ffmpeg.on('error', () => {
        clearTimeout(timeout);
        finish(null);
      });
      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 && chunks.length > 0) finish(Buffer.concat(chunks));
        else finish(null);
      });
    });

    if (!imageData || imageData.length < 4) return null;
    const imageId = await imageStorage.saveImage(vehicleId, channel, imageData, alertId, captureAt);
    return {
      id: String(imageId),
      vehicleId,
      channel,
      timestamp: captureAt.toISOString(),
      fileSize: imageData.length,
      url: `/api/images/${encodeURIComponent(String(imageId))}/file`,
      offsetSeconds: 0,
      source: 'stored_video_frame'
    };
  };
  const ensureAccurateAlertScreenshots = async (
    alertId: string,
    vehicleId: string,
    alertChannel: number,
    alertTs: Date
  ) => {
    const db = require('../storage/database');
    const existing = await db.query(
      `SELECT id FROM images WHERE alert_id = $1 LIMIT 1`,
      [alertId]
    );
    if ((existing.rows || []).length > 0) return;

    const channels = getVehicleChannels(vehicleId, alertChannel).slice(0, 2);
    for (const ch of channels) {
      const segments = await queryStoredVideoSegments(
        vehicleId,
        ch,
        new Date(alertTs.getTime() - 45 * 1000),
        new Date(alertTs.getTime() + 45 * 1000)
      );
      const bestSegment = segments.find((segment: any) => {
        const start = new Date(segment.start_time);
        const end = segment.end_time ? new Date(segment.end_time) : start;
        return start.getTime() <= alertTs.getTime() && end.getTime() >= alertTs.getTime();
      }) || segments[0];
      if (!bestSegment) continue;

      try {
        const created = await extractScreenshotFromStoredSegment(vehicleId, ch, alertId, alertTs, bestSegment);
        if (created?.id) {
          await dbQuery(`UPDATE images SET alert_id = $1 WHERE id = $2`, [alertId, created.id]);
        }
      } catch {}
    }
  };
  const getFfmpegBinary = () => {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const installer = require('@ffmpeg-installer/ffmpeg');
      if (installer?.path) return installer.path;
    } catch {}
    return 'ffmpeg';
  };
  const runFfmpegProfiles = async (profiles: string[][], outputPath: string) => {
    let lastError = 'ffmpeg failed';
    for (const args of profiles) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ffmpeg = spawn(getFfmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          ffmpeg.stderr.on('data', (d) => { stderr += String(d || ''); });
          ffmpeg.on('error', (err) => reject(new Error(err?.message || 'Failed to spawn ffmpeg')));
          ffmpeg.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
              resolve();
              return;
            }
            try {
              if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch {}
            reject(new Error(stderr?.slice(0, 800) || `ffmpeg exited with code ${code}`));
          });
        });
        return;
      } catch (err: any) {
        lastError = err?.message || String(err);
      }
    }
    throw new Error(lastError);
  };
  const toPlayableMp4 = async (sourcePath: string, inputFpsHint?: number) => {
    if (!sourcePath) throw new Error('Missing source file');
    if (!fs.existsSync(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);
    if (/\.mp4$/i.test(sourcePath)) return sourcePath;
    if (/\.farc$/i.test(sourcePath)) {
      const parsedArchive = path.parse(sourcePath);
      const decodedDir = path.join(process.cwd(), 'recordings', 'transcoded', 'archive-decoded');
      try { fs.mkdirSync(decodedDir, { recursive: true }); } catch {}
      const decodedH264 = path.join(decodedDir, `${parsedArchive.name}.decoded.h264`);
      archiveToRawH264(sourcePath, decodedH264);
      sourcePath = decodedH264;
    }

    const safeInputFps = Number.isFinite(Number(inputFpsHint)) && Number(inputFpsHint) > 0
      ? Math.max(0.2, Math.min(30, Number(inputFpsHint)))
      : null;
    const parsed = path.parse(sourcePath);
    const fpsTag = safeInputFps ? `.fps${String(safeInputFps).replace('.', '_')}` : '';
    const outputPath = path.join(parsed.dir, `${parsed.name}${fpsTag}.playable.mp4`);
    const sourceStat = fs.statSync(sourcePath);
    if (fs.existsSync(outputPath)) {
      const outStat = fs.statSync(outputPath);
      if (outStat.size > 0 && outStat.mtimeMs >= sourceStat.mtimeMs) return outputPath;
    }

    const cacheKey = `${sourcePath}=>${outputPath}`;
    const existing = transcodeCache.get(cacheKey);
    if (existing) return existing;

    const task = (async () => {
      const commonOut = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath];
      const profiles: string[][] = [
        ['-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts', '-i', sourcePath, ...commonOut],
        ['-hide_banner', '-loglevel', 'error', '-y', '-r', '25', '-fflags', '+genpts', '-f', 'h264', '-i', sourcePath, ...commonOut],
        ['-hide_banner', '-loglevel', 'error', '-y', '-r', '20', '-f', 'h264', '-i', sourcePath, ...commonOut]
      ];
      if (safeInputFps && !/\.mp4$/i.test(sourcePath)) {
        profiles.unshift([
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-fflags',
          '+genpts',
          '-framerate',
          String(safeInputFps),
          '-f',
          'h264',
          '-i',
          sourcePath,
          ...commonOut
        ]);
      }
      await runFfmpegProfiles(profiles, outputPath);
      return outputPath;
    })().finally(() => {
      transcodeCache.delete(cacheKey);
    });

    transcodeCache.set(cacheKey, task);
    return task;
  };
  const getPlayableVariantPath = (sourcePath: string, inputFpsHint?: number) => {
    if (!sourcePath) return '';
    if (/\.mp4$/i.test(sourcePath)) return sourcePath;
    const safeInputFps = Number.isFinite(Number(inputFpsHint)) && Number(inputFpsHint) > 0
      ? Math.max(0.2, Math.min(30, Number(inputFpsHint)))
      : null;
    const parsed = path.parse(sourcePath);
    const fpsTag = safeInputFps ? `.fps${String(safeInputFps).replace('.', '_')}` : '';
    return path.join(parsed.dir, `${parsed.name}${fpsTag}.playable.mp4`);
  };
  const toPlayableMp4FromHttp = async (sourceUrl: string, cacheId: string) => {
    if (!sourceUrl) throw new Error('Missing source URL');
    if (/\.mp4(?:$|\?)/i.test(sourceUrl)) return sourceUrl;

    const outputDir = path.join(process.cwd(), 'recordings', 'transcoded', 'remote');
    try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}
    const hash = crypto.createHash('sha1').update(`${cacheId}:${sourceUrl}`).digest('hex').slice(0, 16);
    const outputPath = path.join(outputDir, `${hash}.playable.mp4`);

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return outputPath;
    }

    const cacheKey = `http:${sourceUrl}=>${outputPath}`;
    const existing = transcodeCache.get(cacheKey);
    if (existing) return existing;

    const task = (async () => {
      const commonOut = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath];
      const profiles: string[][] = [
        ['-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts', '-i', sourceUrl, ...commonOut],
        ['-hide_banner', '-loglevel', 'error', '-y', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2', '-i', sourceUrl, ...commonOut]
      ];
      await runFfmpegProfiles(profiles, outputPath);
      return outputPath;
    })().finally(() => {
      transcodeCache.delete(cacheKey);
    });

    transcodeCache.set(cacheKey, task);
    return task;
  };
  const resolveAlertClipSource = (videoClips: any, type: 'pre' | 'post' | 'camera') => {
    if (type === 'pre') {
      // Prefer local raw clip path so we can transcode to browser-playable MP4.
      return String(videoClips?.pre || videoClips?.preStorageUrl || '').trim();
    }
    if (type === 'post') {
      // Prefer local raw clip path so we can transcode to browser-playable MP4.
      return String(videoClips?.post || videoClips?.postStorageUrl || '').trim();
    }
    return String(
      videoClips?.cameraVideoLocalPath ||
      videoClips?.cameraVideo ||
      ''
    ).trim();
  };
  const getAlertClipFpsHint = (videoClips: any, type: 'pre' | 'post' | 'camera') => {
    if (type === 'camera') return undefined;
    const duration = Number(type === 'pre' ? videoClips?.preDuration : videoClips?.postDuration);
    const frames = Number(type === 'pre' ? videoClips?.preFrameCount : videoClips?.postFrameCount);
    if (!Number.isFinite(duration) || !Number.isFinite(frames) || duration <= 0 || frames <= 0) {
      return undefined;
    }
    const fps = frames / duration;
    if (!Number.isFinite(fps) || fps <= 0) return undefined;
    return Math.max(0.2, Math.min(30, fps));
  };
  const buildManualVideoJob = (
    vehicleId: string,
    channel: number,
    start: Date,
    end: Date,
    options?: {
      alertId?: string;
      windowType?: 'pre' | 'post';
    }
  ) => {
    const id = `JOB-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const now = new Date().toISOString();
    const durationSec = Math.max(1, Math.min(300, Math.ceil((end.getTime() - start.getTime()) / 1000)));
    const outputDir = path.join(process.cwd(), 'recordings', vehicleId, 'manual');
    const outputName = `${id}_ch${channel}.mp4`;
    const outputPath = path.join(outputDir, outputName);
    const outputUrl = `/api/videos/jobs/${encodeURIComponent(id)}/file`;
    const job = {
      id,
      vehicleId,
      channel,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      alertId: options?.alertId,
      windowType: options?.windowType,
      status: 'queued' as const,
      createdAt: now,
      updatedAt: now,
      outputPath,
      outputUrl
    };
    manualVideoJobs.set(id, job);

    const playlistPath = path.join(process.cwd(), 'hls', vehicleId, `channel_${channel}`, 'playlist.m3u8');
    setTimeout(() => {
      const current = manualVideoJobs.get(id);
      if (!current) return;
      current.status = 'running';
      current.updatedAt = new Date().toISOString();
      manualVideoJobs.set(id, current);

      try {
        fs.mkdirSync(outputDir, { recursive: true });
      } catch {}

      void runFfmpegProfiles([
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          playlistPath,
          '-t',
          String(durationSec),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-pix_fmt',
          'yuv420p',
          '-an',
          '-movflags',
          '+faststart',
          outputPath
        ],
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          playlistPath,
          '-t',
          String(durationSec),
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outputPath
        ]
      ], outputPath).then(() => {
        const finalJob = manualVideoJobs.get(id);
        if (!finalJob) return;
        finalJob.status = 'completed';
        finalJob.updatedAt = new Date().toISOString();
        manualVideoJobs.set(id, finalJob);
        void persistManualJobVideo(finalJob).catch((err: any) => {
          const latest = manualVideoJobs.get(id);
          if (!latest) return;
          latest.error = `Persist failed: ${err?.message || 'unknown error'}`;
          latest.updatedAt = new Date().toISOString();
          manualVideoJobs.set(id, latest);
        });
      }).catch((err: any) => {
        const failed = manualVideoJobs.get(id);
        if (!failed) return;
        failed.status = 'failed';
        failed.error = err?.message || 'ffmpeg failed';
        failed.updatedAt = new Date().toISOString();
        manualVideoJobs.set(id, failed);
      });
    }, 1200);

    return { id, outputUrl };
  };
  const buildStoredWindowVideoJob = (
    vehicleId: string,
    channel: number,
    start: Date,
    end: Date,
    segments: Array<{
      id: string;
      file_path: string;
      start_time: string | Date;
      end_time?: string | Date | null;
      duration_seconds?: number | null;
      frame_count?: number | null;
      alert_id?: string | null;
    }>,
    options?: {
      alertId?: string;
    }
  ) => {
    const id = `JOB-LOCAL-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const now = new Date().toISOString();
    const durationSec = Math.max(1, Math.min(300, Math.ceil((end.getTime() - start.getTime()) / 1000)));
    const outputDir = path.join(process.cwd(), 'recordings', vehicleId, 'manual');
    const outputName = `${id}_ch${channel}.mp4`;
    const outputPath = path.join(outputDir, outputName);
    const outputUrl = `/api/videos/jobs/${encodeURIComponent(id)}/file`;
    const job = {
      id,
      vehicleId,
      channel,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      alertId: options?.alertId,
      status: 'queued' as const,
      createdAt: now,
      updatedAt: now,
      outputPath,
      outputUrl
    };
    manualVideoJobs.set(id, job);

    setTimeout(async () => {
      const current = manualVideoJobs.get(id);
      if (!current) return;
      current.status = 'running';
      current.updatedAt = new Date().toISOString();
      manualVideoJobs.set(id, current);

      try {
        fs.mkdirSync(outputDir, { recursive: true });
      } catch {}

      const concatFilePath = path.join(outputDir, `${id}.concat.txt`);

      try {
        const preparedSources: Array<{ path: string; startTime: Date }> = [];
        for (const segment of segments) {
          const rawPath = String(segment?.file_path || '').trim();
          if (!rawPath) continue;
          const localPath = path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath);
          if (!fs.existsSync(localPath)) continue;

          const fpsHint = inferSegmentInputFps(segment);
          const playablePath = /\.mp4$/i.test(localPath)
            ? localPath
            : await toPlayableMp4(localPath, fpsHint);
          if (!playablePath || !fs.existsSync(playablePath)) continue;

          const segmentStart = new Date(segment.start_time);
          if (Number.isNaN(segmentStart.getTime())) continue;
          preparedSources.push({
            path: playablePath,
            startTime: segmentStart
          });
        }

        if (preparedSources.length === 0) {
          throw new Error('No stored video segments available for requested range');
        }

        preparedSources.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
        const concatBody = preparedSources
          .map((source) => {
            const normalizedPath = source.path.replace(/\\/g, '/').replace(/'/g, "'\\''");
            return `file '${normalizedPath}'`;
          })
          .join('\n');
        fs.writeFileSync(concatFilePath, concatBody, 'utf8');

        const firstStart = preparedSources[0].startTime;
        const trimOffsetSec = Math.max(0, (start.getTime() - firstStart.getTime()) / 1000);
        const browserSafeProfile = [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatFilePath,
          '-ss',
          trimOffsetSec.toFixed(3),
          '-t',
          String(durationSec),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          outputPath
        ];
        const copyProfile = [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatFilePath,
          '-ss',
          trimOffsetSec.toFixed(3),
          '-t',
          String(durationSec),
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outputPath
        ];

        await runFfmpegProfiles([browserSafeProfile, copyProfile], outputPath);

        const finalJob = manualVideoJobs.get(id);
        if (!finalJob) return;
        finalJob.status = 'completed';
        finalJob.updatedAt = new Date().toISOString();
        manualVideoJobs.set(id, finalJob);
        void persistManualJobVideo(finalJob).catch((err: any) => {
          const latest = manualVideoJobs.get(id);
          if (!latest) return;
          latest.error = `Persist failed: ${err?.message || 'unknown error'}`;
          latest.updatedAt = new Date().toISOString();
          manualVideoJobs.set(id, latest);
        });
      } catch (error: any) {
        const failed = manualVideoJobs.get(id);
        if (!failed) return;
        failed.status = 'failed';
        failed.error = error?.message || String(error);
        failed.updatedAt = new Date().toISOString();
        manualVideoJobs.set(id, failed);
      } finally {
        try {
          if (fs.existsSync(concatFilePath)) fs.unlinkSync(concatFilePath);
        } catch {}
      }
    }, 50);

    return { id, outputUrl };
  };
  const toNumericLimit = (value: unknown, fallback: number, min = 1, max = 500) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  };
  const toNumericMinutes = (value: unknown, fallback: number, min = 1, max = 7 * 24 * 60) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  };
  const normalizeAlertRecord = (alert: any) => {
    const metadata = typeof alert?.metadata === 'string'
      ? (() => { try { return JSON.parse(alert.metadata || '{}'); } catch { return {}; } })()
      : (alert?.metadata || {});
    const latitude =
      Number.isFinite(Number(alert?.latitude)) ? Number(alert?.latitude)
      : (Number.isFinite(Number(metadata?.locationFix?.latitude)) ? Number(metadata.locationFix.latitude) : null);
    const longitude =
      Number.isFinite(Number(alert?.longitude)) ? Number(alert?.longitude)
      : (Number.isFinite(Number(metadata?.locationFix?.longitude)) ? Number(metadata.locationFix.longitude) : null);
    const vehicle = metadata?.vehicle || {};
    const vehicleId = alert?.vehicleId || alert?.device_id || alert?.deviceId;
    return {
      ...alert,
      metadata,
      vehicleId,
      location: (latitude !== null && longitude !== null) ? { latitude, longitude } : null,
      vehicle: {
        vehicleId,
        terminalPhone: vehicle?.terminalPhone || vehicleId || null,
        plateNumber: vehicle?.plateNumber || null,
        plateColor: vehicle?.plateColor ?? null,
        manufacturerId: vehicle?.manufacturerId || null,
        terminalModel: vehicle?.terminalModel || null,
        terminalId: vehicle?.terminalId || null
      },
      type: alert?.type || alert?.alert_type,
      priority: alert?.priority || 'high',
      status: alert?.status || (alert?.resolved ? 'resolved' : 'new'),
      timestamp: alert?.timestamp
    };
  };
  const mergeRecentAlerts = (lists: any[][], limit: number) => {
    const seen = new Set<string>();
    const merged: any[] = [];
    lists.flat().forEach((a: any) => {
      const id = String(a?.id || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      merged.push(a);
    });
    merged.sort((a: any, b: any) => new Date(b?.timestamp || 0).getTime() - new Date(a?.timestamp || 0).getTime());
    return merged.slice(0, limit);
  };

  const persistManualJobVideo = async (job: {
    id: string;
    vehicleId: string;
    channel: number;
    startTime: string;
    endTime: string;
    alertId?: string;
    windowType?: 'pre' | 'post';
    outputPath?: string;
  }) => {
    if (!job.outputPath || !fs.existsSync(job.outputPath)) return;

    const stats = fs.statSync(job.outputPath);
    const start = new Date(job.startTime);
    const end = new Date(job.endTime);
    const duration = Math.max(1, Math.round((end.getTime() - start.getTime()) / 1000));
    const videoType = job.alertId ? 'camera_sd' : 'manual';

    const videoId = await videoStorage.saveVideo(
      job.vehicleId,
      job.channel,
      job.outputPath,
      start,
      videoType,
      job.alertId
    );
    await videoStorage.updateVideoEnd(videoId, end, stats.size, duration);

    let persistedUrl = buildStoredVideoUrl(String(videoId));
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const uploaded = await videoStorage.uploadVideoToSupabase(
        videoId,
        job.outputPath,
        job.vehicleId,
        job.channel
      );
      if (uploaded) persistedUrl = normalizePublicVideoUrl(uploaded, persistedUrl);
    }

    const current = manualVideoJobs.get(job.id);
    if (current) {
      current.persistedVideoId = String(videoId);
      current.persistedVideoUrl = persistedUrl;
      current.updatedAt = new Date().toISOString();
      manualVideoJobs.set(job.id, current);
    }

    if (job.alertId) {
      const alertResult = await dbQuery(
        'SELECT metadata FROM alerts WHERE id = $1',
        [job.alertId]
      );
      if (alertResult.rows.length > 0) {
        const rawMeta = alertResult.rows[0].metadata;
        const metadata = typeof rawMeta === 'string' ? JSON.parse(rawMeta || '{}') : (rawMeta || {});
        metadata.videoClips = metadata.videoClips || {};
        const normalized = normalizePublicVideoUrl(
          persistedUrl,
          `/api/videos/jobs/${encodeURIComponent(job.id)}/file`
        );
        if (job.windowType === 'pre') {
          metadata.videoClips.cameraPreVideo = normalized;
          metadata.videoClips.cameraPreVideoLocalPath = job.outputPath;
          metadata.videoClips.cameraPreVideoJobId = job.id;
          metadata.videoClips.cameraPreVideoVideoId = String(videoId);
          // Preserve legacy fields for existing clients.
          metadata.videoClips.cameraVideo = normalized;
          metadata.videoClips.cameraVideoLocalPath = job.outputPath;
          metadata.videoClips.cameraVideoJobId = job.id;
          metadata.videoClips.cameraVideoVideoId = String(videoId);
        } else if (job.windowType === 'post') {
          metadata.videoClips.cameraPostVideo = normalized;
          metadata.videoClips.cameraPostVideoLocalPath = job.outputPath;
          metadata.videoClips.cameraPostVideoJobId = job.id;
          metadata.videoClips.cameraPostVideoVideoId = String(videoId);
        } else {
          metadata.videoClips.cameraVideo = normalized;
          metadata.videoClips.cameraVideoLocalPath = job.outputPath;
          metadata.videoClips.cameraVideoJobId = job.id;
          metadata.videoClips.cameraVideoVideoId = String(videoId);
        }
        await dbQuery(
          'UPDATE alerts SET metadata = $1 WHERE id = $2',
          [JSON.stringify(metadata), job.alertId]
        );
      }
    }
  };

  // Auto-capture and persist an alert-linked playback file whenever alert workflow
  // requests camera video. This ensures alert APIs return a video URL once ready.
  const alertManager = tcpServer.getAlertManager();
  alertManager.on('request-camera-video', ({ vehicleId, channel, startTime, endTime, alertId, windowType }) => {
    if (!alertId || !vehicleId) return;
    const dedupeKey = `${String(alertId)}:${String(windowType || 'generic')}`;
    if (queuedAlertWindows.has(dedupeKey)) return;
    queuedAlertWindows.add(dedupeKey);
    buildManualVideoJob(
      String(vehicleId),
      Number(channel || 1),
      new Date(startTime),
      new Date(endTime),
      { alertId: String(alertId), windowType: windowType === 'post' ? 'post' : 'pre' }
    );
  });

  // Get all connected vehicles with their channels
  router.get('/vehicles', (req, res) => {
    const vehicles = tcpServer.getVehicles();
    res.json({
      success: true,
      data: vehicles.map(v => ({
        id: v.id,
        phone: v.phone,
        connected: v.connected,
        lastHeartbeat: v.lastHeartbeat,
        activeStreams: Array.from(v.activeStreams),
        channels: v.channels || []
      }))
    });
  });

  // Diagnostics: inspect recent raw JT/T 808 packets and parser output.
  // Useful to compare real payloads against documented 0x0200/0x0704 format.
  router.get('/diag/messages', (req, res) => {
    const vehicleId = String(req.query.vehicleId || '').trim();
    const messageIdRaw = String(req.query.messageId || '').trim();
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 300));

    let messageId: number | undefined;
    if (messageIdRaw) {
      if (/^0x[0-9a-f]+$/i.test(messageIdRaw)) {
        messageId = parseInt(messageIdRaw, 16);
      } else if (/^\d+$/.test(messageIdRaw)) {
        messageId = parseInt(messageIdRaw, 10);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Invalid messageId. Use decimal (e.g. 516) or hex (e.g. 0x0204).'
        });
      }
    }

    const messages = tcpServer.getRecentMessageTraces({
      vehicleId: vehicleId || undefined,
      messageId,
      limit
    });

    res.json({
      success: true,
      filters: {
        vehicleId: vehicleId || null,
        messageId: typeof messageId === 'number' ? messageId : null,
        messageIdHex: typeof messageId === 'number' ? `0x${messageId.toString(16).padStart(4, '0')}` : null,
        limit
      },
      count: messages.length,
      messages
    });
  });

  // Diagnostics: raw ingest feed written by protocol handlers.
  // Source file: logs/raw-ingest.ndjson
  router.get('/diag/raw-ingest', (req, res) => {
    try {
      const logPath = path.join(process.cwd(), 'logs', 'raw-ingest.ndjson');
      const exists = fs.existsSync(logPath);
      if (!exists) {
        return res.json({
          success: true,
          count: 0,
          filters: {
            eventType: null,
            messageIdHex: null,
            vehicleId: null,
            limit: 0
          },
          entries: []
        });
      }

      const eventType = String(req.query.eventType || '').trim().toLowerCase();
      const messageIdHex = String(req.query.messageIdHex || '').trim().toLowerCase();
      const vehicleId = String(req.query.vehicleId || '').trim();
      const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 2000));

      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

      // newest-first by iterating from end
      const entries: any[] = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        let row: any = null;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || typeof row !== 'object') continue;

        if (eventType && String(row.eventType || '').toLowerCase() !== eventType) continue;
        if (messageIdHex && String(row.messageIdHex || '').toLowerCase() !== messageIdHex) continue;
        if (vehicleId && String(row.vehicleId || '') !== vehicleId) continue;

        entries.push(row);
        if (entries.length >= limit) break;
      }

      return res.json({
        success: true,
        count: entries.length,
        totalLines: lines.length,
        source: '/logs/raw-ingest.ndjson',
        filters: {
          eventType: eventType || null,
          messageIdHex: messageIdHex || null,
          vehicleId: vehicleId || null,
          limit
        },
        entries
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to read raw ingest log',
        error: error?.message || String(error)
      });
    }
  });

  // Start all video channels for a vehicle
  router.post('/vehicles/:id/start-all-streams', (req, res) => {
    const { id } = req.params;
    const vehicle = tcpServer.getVehicle(id);

    if (!vehicle || !vehicle.connected) {
      return res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found or not connected`
      });
    }

    const videoChannels = vehicle.channels?.filter(ch => ch.type === 'video' || ch.type === 'audio_video') || [];
    const results = [];

    for (const channel of videoChannels) {
      const success = tcpServer.startVideo(id, channel.logicalChannel);
      results.push({
        channel: channel.logicalChannel,
        type: channel.type,
        success
      });
    }

    res.json({
      success: true,
      message: `Started ${results.filter(r => r.success).length}/${results.length} video streams`,
      data: results
    });
  });

  // Stop all video channels for a vehicle
  router.post('/vehicles/:id/stop-all-streams', (req, res) => {
    const { id } = req.params;
    const vehicle = tcpServer.getVehicle(id);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found`
      });
    }

    const activeChannels = Array.from(vehicle.activeStreams);
    const results = [];

    for (const channel of activeChannels) {
      const success = tcpServer.stopVideo(id, channel);
      udpServer.stopStream(id, channel);
      results.push({ channel, success });
    }

    res.json({
      success: true,
      message: `Stopped ${results.length} video streams`,
      data: results
    });
  });

  // Start live video for a vehicle
  router.post('/vehicles/:id/start-live', (req, res) => {
    const { id } = req.params;
    const { channel = 1 } = req.body;

    console.log(`📡 API: start-live called for vehicle ${id}, channel ${channel}`);

    const success = tcpServer.startVideo(id, channel);
    if (success) {
      udpServer.startHLSStream(id, channel);
      res.json({
        success: true,
        message: `Video stream started for vehicle ${id}, channel ${channel}`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found or not connected`
      });
    }
  });

  // Optimize camera video parameters
  router.post('/vehicles/:id/optimize-video', (req, res) => {
    const { id } = req.params;
    const { channel = 1 } = req.body;

    const success = tcpServer.optimizeVideoParameters(id, channel);

    if (success) {
      res.json({
        success: true,
        message: `Camera optimized for ${id} channel ${channel}`,
        settings: {
          resolution: 'CIF (352x288)',
          frameRate: '15 fps',
          bitrate: '512 kbps',
          speedup: '3-5x faster'
        }
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found`
      });
    }
  });

  // Configure video alarm mask (0x007A). maskWord=0 un-masks all video alarms.
  router.post('/vehicles/:id/config/video-alarm-mask', (req, res) => {
    const { id } = req.params;
    const maskWord = Number(req.body?.maskWord ?? 0) >>> 0;
    const success = tcpServer.setVideoAlarmMask(id, maskWord);

    if (success) {
      return res.json({
        success: true,
        message: `Video alarm mask set for ${id}`,
        data: {
          vehicleId: id,
          maskWord,
          maskHex: `0x${maskWord.toString(16).padStart(8, '0')}`
        }
      });
    }

    return res.status(404).json({
      success: false,
      message: `Vehicle ${id} not found or not connected`
    });
  });

  // Configure image analysis alarm params (0x007B)
  router.post('/vehicles/:id/config/image-analysis', (req, res) => {
    const { id } = req.params;
    const approvedPassengers = Number(req.body?.approvedPassengers ?? 0);
    const fatigueThreshold = Number(req.body?.fatigueThreshold ?? 70);
    const success = tcpServer.setImageAnalysisAlarmParams(id, approvedPassengers, fatigueThreshold);

    if (success) {
      return res.json({
        success: true,
        message: `Image analysis parameters set for ${id}`,
        data: {
          vehicleId: id,
          approvedPassengers,
          fatigueThreshold
        }
      });
    }

    return res.status(404).json({
      success: false,
      message: `Vehicle ${id} not found or not connected`
    });
  });

  // Switch stream quality
  router.post('/vehicles/:id/switch-stream', (req, res) => {
    const { id } = req.params;
    const { channel = 1, streamType = 1 } = req.body; // 0=main, 1=sub

    const success = tcpServer.switchStream(id, channel, streamType);

    if (success) {
      res.json({
        success: true,
        message: `Switched to ${streamType === 0 ? 'main' : 'sub'} stream for vehicle ${id}, channel ${channel}`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found or not connected`
      });
    }
  });

  // Stop live video for a vehicle
  router.post('/vehicles/:id/stop-live', (req, res) => {
    const { id } = req.params;
    const { channel = 1 } = req.body;

    const success = tcpServer.stopVideo(id, channel);
    udpServer.stopStream(id, channel);

    // Also stop TCP RTP handler stream
    const tcpRTPHandler = (tcpServer as any).rtpHandler;
    if (tcpRTPHandler?.stopStream) {
      tcpRTPHandler.stopStream(id, channel);
    }

    if (success) {
      res.json({
        success: true,
        message: `Video stream stopped for vehicle ${id}, channel ${channel}`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found`
      });
    }
  });

  // Request screenshot from vehicle
  router.post('/vehicles/:id/screenshot', async (req, res) => {
    const { id } = req.params;
    const { channel = 1, fallback = true, fallbackDelayMs = 600 } = req.body;
    const result = await tcpServer.requestScreenshotWithFallback(id, Number(channel), {
      fallback: !!fallback,
      fallbackDelayMs: Number(fallbackDelayMs)
    });

    if (!result.success) {
      res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found or not connected`
      });
      return;
    }

    res.json({
      success: true,
      message: `Screenshot requested for vehicle ${id}, channel ${channel}`,
      fallback: result.fallback || { ok: false, reason: 'disabled' }
    });
  });

  // Alias route used by external frontend proxy path
  router.post('/video-server/vehicles/:id/screenshot', async (req, res) => {
    const { id } = req.params;
    const { channel = 1, fallback = true, fallbackDelayMs = 600 } = req.body;
    const result = await tcpServer.requestScreenshotWithFallback(id, Number(channel), {
      fallback: !!fallback,
      fallbackDelayMs: Number(fallbackDelayMs)
    });

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found or not connected`
      });
    }

    res.json({
      success: true,
      message: `Screenshot requested for vehicle ${id}, channel ${channel}`,
      fallback: result.fallback || { ok: false, reason: 'disabled' }
    });
  });

  // Get stream info for a vehicle
  router.get('/vehicles/:id/stream-info', (req, res) => {
    const { id } = req.params;
    const { channel = 1 } = req.query;

    const vehicle = tcpServer.getVehicle(id);
    const streamInfo = udpServer.getStreamInfo(id, Number(channel));

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found`
      });
    }

    res.json({
      success: true,
      data: {
        vehicle: {
          id: vehicle.id,
          connected: vehicle.connected,
          lastHeartbeat: vehicle.lastHeartbeat
        },
        stream: streamInfo || {
          vehicleId: id,
          channel: Number(channel),
          active: false,
          frameCount: 0,
          lastFrame: null
        }
      }
    });
  });

  // Get all active streams for a vehicle
  router.get('/vehicles/:id/streams', (req, res) => {
    const { id } = req.params;
    const vehicle = tcpServer.getVehicle(id);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found`
      });
    }

    const streams = [];
    for (const channel of vehicle.activeStreams) {
      const streamInfo = udpServer.getStreamInfo(id, channel);
      const channelInfo = vehicle.channels?.find(ch => ch.logicalChannel === channel);

      streams.push({
        channel,
        type: channelInfo?.type || 'unknown',
        hasGimbal: channelInfo?.hasGimbal || false,
        streamInfo: streamInfo || {
          vehicleId: id,
          channel,
          active: false,
          frameCount: 0,
          lastFrame: null
        },
        playlistUrl: `/api/stream/${id}/${channel}/playlist.m3u8`
      });
    }

    res.json({
      success: true,
      data: {
        vehicleId: id,
        totalChannels: vehicle.channels?.length || 0,
        activeStreams: streams.length,
        streams
      }
    });
  });

  // Query camera capabilities
  router.post('/vehicles/:id/query-capabilities', (req, res) => {
    const { id } = req.params;

    const success = tcpServer.queryCapabilities(id);

    if (success) {
      res.json({
        success: true,
        message: `Querying capabilities for vehicle ${id}, check logs for response`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Vehicle ${id} not found or not connected`
      });
    }
  });

  // Get server statistics
  router.get('/stats', (req, res) => {
    const vehicles = tcpServer.getVehicles();
    const udpStats = udpServer.getStats();

    res.json({
      success: true,
      data: {
        connectedVehicles: vehicles.filter(v => v.connected).length,
        totalVehicles: vehicles.length,
        activeStreams: udpStats.activeStreams,
        totalStreams: udpStats.totalStreams,
        frameAssembler: udpStats.frameAssemblerStats
      }
    });
  });

  // Serve HLS playlist
  router.get('/stream/:vehicleId/:channel/playlist.m3u8', (req, res) => {
    const { vehicleId, channel } = req.params;
    const playlistPath = path.join(process.cwd(), 'hls', vehicleId, `channel_${channel}`, 'playlist.m3u8');
    res.sendFile(playlistPath);
  });

  // Serve HLS segments
  router.get('/stream/:vehicleId/:channel/:segment', (req, res) => {
    const { vehicleId, channel, segment } = req.params;
    const segmentPath = path.join(process.cwd(), 'hls', vehicleId, `channel_${channel}`, segment);
    res.sendFile(segmentPath);
  });

  // Get alerts
  router.get('/alerts', async (req, res) => {
    try {
      const alertManager = tcpServer.getAlertManager();
      const status = String(req.query.status || '').trim();
      const priority = String(req.query.priority || '').trim();
      const limit = toNumericLimit(req.query.limit, 10);
      const hasMinutesFilter = req.query.minutes !== undefined && req.query.minutes !== null && String(req.query.minutes).trim() !== '';
      const minutes = hasMinutesFilter ? toNumericMinutes(req.query.minutes, 180) : null;

      const memAlertsRaw = alertManager.getActiveAlerts();
      let memAlerts = memAlertsRaw.map((a: any) => normalizeAlertRecord(a));
      if (status) memAlerts = memAlerts.filter((a: any) => String(a?.status || '').toLowerCase() === status.toLowerCase());
      if (priority) memAlerts = memAlerts.filter((a: any) => String(a?.priority || '').toLowerCase() === priority.toLowerCase());

      const where: string[] = [];
      const params: any[] = [];
      let p = 1;
      if (minutes !== null) {
        where.push(`timestamp >= NOW() - ($${p++}::int * INTERVAL '1 minute')`);
        params.push(minutes);
      }
      if (status) {
        where.push(`LOWER(COALESCE(status, '')) = LOWER($${p++})`);
        params.push(status);
      }
      if (priority) {
        where.push(`LOWER(COALESCE(priority, '')) = LOWER($${p++})`);
        params.push(priority);
      }
      params.push(Math.max(limit * 5, 50));
      const dbResult = await require('../storage/database').query(
        `SELECT id, device_id, channel, alert_type, priority, status, timestamp, latitude, longitude, metadata
         FROM alerts
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY timestamp DESC
         LIMIT $${p}`,
        params
      );
      const dbAlerts = dbResult.rows.map((r: any) => normalizeAlertRecord(r));

      const alerts = mergeRecentAlerts([memAlerts, dbAlerts], limit).map(withAlertMediaLinks);
      res.json({
        success: true,
        alerts,
        count: alerts.length,
        source: 'merged',
        window_minutes: minutes
      });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch alerts' });
    }
  });

  // Clear all existing alerts from DB + in-memory active state
  router.delete('/alerts/clear', async (_req, res) => {
    try {
      const alertManager = tcpServer.getAlertManager();
      const beforeMem = alertManager.getActiveAlerts().length;
      const dbResult = await dbQuery('DELETE FROM alerts');
      const { clearedInMemory } = await alertManager.clearAllAlerts();

      return res.json({
        success: true,
        message: 'All alerts cleared',
        cleared: {
          database: Number(dbResult.rowCount || 0),
          inMemoryBefore: beforeMem,
          inMemoryCleared: clearedInMemory
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to clear alerts',
        error: error?.message || String(error)
      });
    }
  });

  // Get vehicle images
  router.get('/vehicles/:id/images', async (req, res) => {
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;

    try {
      const result = await require('../storage/database').query(
        `SELECT id, device_id, channel, storage_url, file_size, timestamp 
         FROM images 
         WHERE device_id = $1 
         ORDER BY timestamp DESC 
         LIMIT $2`,
        [id, limit]
      );

      res.json({
        success: true,
        data: result.rows.map((img: any) => ({
          id: img.id,
          deviceId: img.device_id,
          channel: img.channel,
          url: normalizePublicImageUrl(img),
          fileSize: img.file_size,
          timestamp: img.timestamp
        }))
      });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch images' });
    }
  });

  // Serve media files
  router.get('/media/:vehicleId/:filename', (req, res) => {
    const { vehicleId, filename } = req.params;
    const { download } = req.query;
    const filePath = path.join(process.cwd(), 'media', vehicleId, filename);

    if (require('fs').existsSync(filePath)) {
      // Set proper content type for images
      if (filename.match(/\.(jpg|jpeg)$/i)) {
        res.setHeader('Content-Type', 'image/jpeg');
      } else if (filename.match(/\.png$/i)) {
        res.setHeader('Content-Type', 'image/png');
      } else if (filename.match(/\.mp4$/i)) {
        res.setHeader('Content-Type', 'video/mp4');
      }

      if (download === 'true') {
        res.download(filePath, filename);
      } else {
        res.sendFile(path.resolve(filePath));
      }
    } else {
      res.status(404).json({ success: false, message: 'File not found' });
    }
  });

  // Get all images from all vehicles
  router.get('/images', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const result = await require('../storage/database').query(
        `SELECT id, device_id, channel, storage_url, file_size, timestamp 
         FROM images 
         ORDER BY timestamp DESC 
         LIMIT $1`,
        [limit]
      );

      res.json({
        success: true,
        total: result.rows.length,
        data: result.rows.map((img: any) => ({
          id: img.id,
          deviceId: img.device_id,
          channel: img.channel,
          url: normalizePublicImageUrl(img),
          fileSize: img.file_size,
          timestamp: img.timestamp
        }))
      });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch images' });
    }
  });

  // Get all devices
  router.get('/devices', async (req, res) => {
    const devices = await tcpServer.getDevices();
    res.json({
      success: true,
      total: devices.length,
      data: devices
    });
  });

  // === ALERT MANAGEMENT ENDPOINTS ===
  // IMPORTANT: Specific routes MUST come BEFORE parameterized routes (/alerts/:id)

  // Get active alerts
  router.get('/alerts/active', async (req, res) => {
    try {
      const alertManager = tcpServer.getAlertManager();
      const limit = toNumericLimit(req.query.limit, 50);
      const hasMinutesFilter = req.query.minutes !== undefined && req.query.minutes !== null && String(req.query.minutes).trim() !== '';
      const minutes = hasMinutesFilter ? toNumericMinutes(req.query.minutes, 180) : null;

      const memAlerts = alertManager
        .getActiveAlerts()
        .map((a: any) => normalizeAlertRecord(a))
        .filter((a: any) => ['new', 'acknowledged', 'escalated'].includes(String(a?.status || '').toLowerCase()));

      let dbAlerts: any[] = [];
      try {
        const dbWhere: string[] = [
          `(resolved IS DISTINCT FROM TRUE)`,
          `(status IS NULL OR LOWER(status) NOT IN ('resolved', 'closed'))`
        ];
        const dbParams: any[] = [];
        let px = 1;
        if (minutes !== null) {
          dbWhere.push(`timestamp >= NOW() - ($${px++}::int * INTERVAL '1 minute')`);
          dbParams.push(minutes);
        }
        dbParams.push(Math.max(limit * 5, 50));
        const dbResult = await require('../storage/database').query(
          `SELECT id, device_id, channel, alert_type, priority, status, timestamp, latitude, longitude, metadata
           FROM alerts
           WHERE ${dbWhere.join(' AND ')}
           ORDER BY timestamp DESC
           LIMIT $${px}`,
          dbParams
        );
        dbAlerts = dbResult.rows.map((r: any) => normalizeAlertRecord(r));
      } catch (dbErr: any) {
        console.error('alerts/active DB query failed:', dbErr?.message || dbErr);
      }
      const alerts = mergeRecentAlerts([memAlerts, dbAlerts], limit).map(withAlertMediaLinks);

      res.json({
        success: true,
        alerts,
        count: alerts.length,
        source: 'merged',
        window_minutes: minutes
      });
    } catch (error: any) {
      console.error('alerts/active failed:', error?.message || error);
      // Final fallback: in-memory only
      try {
        const fallbackLimit = toNumericLimit(req.query.limit, 10);
        const memOnly = tcpServer.getAlertManager()
          .getActiveAlerts()
          .map((a: any) => normalizeAlertRecord(a))
          .slice(0, fallbackLimit)
          .map(withAlertMediaLinks);
        return res.json({
          success: true,
          alerts: memOnly,
          count: memOnly.length,
          source: 'memory-fallback',
          window_minutes: toNumericMinutes(req.query.minutes, 180)
        });
      } catch {
        return res.status(500).json({ success: false, message: 'Failed to fetch active alerts' });
      }
    }
  });

  // Get alert statistics (moved before :id)
  router.get('/alerts/stats', (req, res) => {
    const alertManager = tcpServer.getAlertManager();
    const stats = alertManager.getAlertStats();
    res.json({
      success: true,
      stats: {
        total: stats.total,
        byStatus: {
          new: stats.new,
          acknowledged: stats.acknowledged,
          escalated: stats.escalated,
          resolved: stats.resolved
        },
        byPriority: stats.byPriority
      }
    });
  });

  // Get unresolved alerts
  router.get('/alerts/unresolved', async (req, res) => {
    try {
      const result = await require('../storage/database').query(
        `SELECT a.*, 
                EXTRACT(EPOCH FROM (NOW() - a.timestamp))/60 as minutes_open
         FROM alerts a
         WHERE status IN ('new', 'acknowledged', 'escalated')
         ORDER BY timestamp DESC`
      );
      res.json({ success: true, total: result.rows.length, data: result.rows });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch unresolved alerts' });
    }
  });

  // Get driver behavior alerts
  router.get('/alerts/driver-behavior', async (req, res) => {
    try {
      const result = await require('../storage/database').query(
        `SELECT * FROM alerts 
         WHERE alert_type IN ('Driver Fatigue', 'Phone Call While Driving', 'Smoking While Driving')
         ORDER BY timestamp DESC LIMIT 100`
      );
      res.json({ success: true, total: result.rows.length, data: result.rows });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch driver behavior alerts' });
    }
  });

  // Get alerts by device
  router.get('/alerts/by-device', async (req, res) => {
    try {
      const result = await require('../storage/database').query(
        `SELECT device_id, COUNT(*) as total_alerts,
                COUNT(*) FILTER (WHERE status = 'new') as new_alerts,
                COUNT(*) FILTER (WHERE priority = 'critical') as critical_alerts,
                MAX(timestamp) as last_alert_time
         FROM alerts
         GROUP BY device_id
         ORDER BY MAX(timestamp) DESC`
      );
      res.json({ success: true, total: result.rows.length, data: result.rows });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch alerts by device' });
    }
  });

  // Get alert history
  router.get('/alerts/history', async (req, res) => {
    try {
      const { device_id, days = 7 } = req.query;
      const limit = toNumericLimit(req.query.limit, 100, 1, 1000);
      let query = `SELECT * FROM alerts WHERE timestamp > NOW() - INTERVAL '${days} days'`;
      const params: any[] = [];
      if (device_id) {
        query += ' AND device_id = $1';
        params.push(device_id);
      }
      query += ' ORDER BY timestamp DESC LIMIT $' + (params.length + 1);
      params.push(limit);
      const result = await require('../storage/database').query(query, params);
      res.json({ success: true, total: result.rows.length, data: result.rows });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch alert history' });
    }
  });

  // Get alerts grouped by priority (moved before :id)
  router.get('/alerts/by-priority', (req, res) => {
    const alertManager = tcpServer.getAlertManager();
    const alerts = alertManager.getActiveAlerts();

    const grouped = {
      critical: alerts.filter(a => a.priority === 'critical'),
      high: alerts.filter(a => a.priority === 'high'),
      medium: alerts.filter(a => a.priority === 'medium'),
      low: alerts.filter(a => a.priority === 'low')
    };

    res.json({
      success: true,
      alertsByPriority: grouped,
      counts: {
        critical: grouped.critical.length,
        high: grouped.high.length,
        medium: grouped.medium.length,
        low: grouped.low.length,
        total: alerts.length
      }
    });
  });

  // Get unattended alerts (moved before :id)
  router.get('/alerts/unattended', async (req, res) => {
    const minutesThreshold = parseInt(req.query.minutes as string) || 30;

    try {
      const alertStorage = require('../storage/alertStorageDB');
      const alerts = await new alertStorage.AlertStorageDB().getUnattendedAlerts(minutesThreshold);

      res.json({
        success: true,
        unattendedAlerts: alerts,
        count: alerts.length,
        threshold_minutes: minutesThreshold
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch unattended alerts'
      });
    }
  });

  // Get buffer statistics (moved before :id)
  router.get('/alerts/buffers/stats', (req, res) => {
    const alertManager = tcpServer.getAlertManager();
    const stats = alertManager.getBufferStats();
    res.json({
      success: true,
      data: stats
    });
  });

  // Get normalized alert signals for one alert
  router.get('/alerts/:id/signals', async (req, res) => {
    const { id } = req.params;

    try {
      const result = await require('../storage/database').query(
        `SELECT id, alert_type, priority, timestamp, metadata
         FROM alerts
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      const row = result.rows[0];
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});

      res.json({
        success: true,
        data: {
          id: row.id,
          timestamp: row.timestamp,
          priority: row.priority,
          primaryAlertType: metadata.primaryAlertType || row.alert_type,
          alertSignals: metadata.alertSignals || [],
          alertSignalDetails: metadata.alertSignalDetails || [],
          alarmFlags: metadata.alarmFlags || {},
          alarmFlagSetBits: metadata.alarmFlagSetBits || [],
          videoAlarms: metadata.videoAlarms || {},
          drivingBehavior: metadata.drivingBehavior || {},
          rawAlarmFlag: metadata.rawAlarmFlag,
          rawStatusFlag: metadata.rawStatusFlag
        }
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch alert signals',
        error: error?.message
      });
    }
  });

  // Collect alert evidence on demand (screenshots from all video channels + report-video request)
  router.post('/alerts/:id/collect-evidence', async (req, res) => {
    const { id } = req.params;
    const ensureScreenshots = String(req.body?.ensureScreenshots ?? 'true').toLowerCase() !== 'false';
    const ensureVideo = String(req.body?.ensureVideo ?? 'true').toLowerCase() !== 'false';

    try {
      const row = await loadAlertRow(id);
      if (!row) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      const vehicleId = String(row.device_id || '');
      const channel = Number(row.channel || 1);
      const ts = new Date(row.timestamp);
      if (!vehicleId || Number.isNaN(ts.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Alert has invalid vehicle or timestamp'
        });
      }

      const ensure = await ensureAlertMediaRequested(id, vehicleId, channel, ts, {
        ensureScreenshots,
        ensureVideo
      });

      return res.json({
        success: true,
        message: `Evidence collection triggered for alert ${id}`,
        data: {
          alertId: id,
          vehicleId,
          channel,
          alertTimestamp: ts.toISOString(),
          ensure
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to collect alert evidence',
        error: error?.message || String(error)
      });
    }
  });

  // Get alert-linked screenshots (strict by alert_id, with timestamp window fallback)
  router.get('/alerts/:id/screenshots', async (req, res) => {
    const { id } = req.params;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const includeFallback = String(req.query.includeFallback ?? 'true').toLowerCase() !== 'false';
    const minutesWindow = Math.max(1, Math.min(30, Number(req.query.windowMinutes || 2)));
    const strictThresholdSeconds = Math.max(1, Math.min(60, Number(req.query.thresholdSeconds || process.env.ALERT_SCREENSHOT_THRESHOLD_SECONDS || 10)));

    try {
      const row = await loadAlertRow(id);
      if (!row) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      const db = require('../storage/database');
      const linked = await backfillAlertMediaLinks(id, row);
      const alertVehicleId = String(row.device_id || '');
      const alertChannel = Number(row.channel || 1);
      const alertTs = new Date(row.timestamp);
      await ensureAccurateAlertScreenshots(id, alertVehicleId, alertChannel, alertTs);
      const fallbackFrom = new Date(alertTs.getTime() - minutesWindow * 60 * 1000);
      const fallbackTo = new Date(alertTs.getTime() + minutesWindow * 60 * 1000);

      const queryText = includeFallback
        ? `WITH direct AS (
             SELECT id, device_id, channel, storage_url, file_size, timestamp, alert_id
             FROM images
             WHERE alert_id = $1
           ),
           fallback AS (
             SELECT id, device_id, channel, storage_url, file_size, timestamp, alert_id
             FROM images
             WHERE alert_id IS NULL
               AND device_id = $2
               AND timestamp BETWEEN $3 AND $4
               AND channel BETWEEN GREATEST($5 - 1, 1) AND ($5 + 1)
           )
           SELECT DISTINCT ON (id)
             id, device_id, channel, storage_url, file_size, timestamp, alert_id
           FROM (
             SELECT * FROM direct
             UNION ALL
             SELECT * FROM fallback
           ) q
           ORDER BY id, timestamp DESC
           LIMIT $6`
        : `SELECT id, device_id, channel, storage_url, file_size, timestamp, alert_id
           FROM images
           WHERE alert_id = $1
           ORDER BY timestamp DESC
           LIMIT $2`;

      const params = includeFallback
        ? [id, alertVehicleId, fallbackFrom, fallbackTo, alertChannel, limit]
        : [id, limit];
      const result = await db.query(queryText, params);

      const screenshots = result.rows.map((img: any) => {
        const ts = new Date(img.timestamp);
        const offsetSeconds = Number.isNaN(ts.getTime())
          ? null
          : Number(((ts.getTime() - alertTs.getTime()) / 1000).toFixed(3));
        return {
        id: img.id,
        alertId: img.alert_id || id,
        vehicleId: img.device_id,
        channel: Number(img.channel || 1),
        timestamp: img.timestamp,
        fileSize: Number(img.file_size || 0),
        url: normalizePublicImageUrl(img),
        offsetSeconds
      };
      }).sort((a: any, b: any) => {
        const aDirect = String(a.alertId || '') === id ? 0 : 1;
        const bDirect = String(b.alertId || '') === id ? 0 : 1;
        if (aDirect !== bDirect) return aDirect - bDirect;
        const aOffset = Math.abs(Number(a.offsetSeconds ?? Number.MAX_SAFE_INTEGER));
        const bOffset = Math.abs(Number(b.offsetSeconds ?? Number.MAX_SAFE_INTEGER));
        return aOffset - bOffset;
      }).filter((shot: any) => Math.abs(Number(shot.offsetSeconds ?? Number.MAX_SAFE_INTEGER)) <= strictThresholdSeconds)
        .slice(0, limit);

      const byChannel: Record<string, any[]> = {};
      for (const s of screenshots) {
        const key = `ch${s.channel}`;
        byChannel[key] = byChannel[key] || [];
        byChannel[key].push(s);
      }

      return res.json({
        success: true,
        data: {
          alertId: id,
          vehicleId: alertVehicleId,
          channel: alertChannel,
          alertTimestamp: row.timestamp,
          thresholdSeconds: strictThresholdSeconds,
          count: screenshots.length,
          screenshots,
          byChannel,
          linked
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch alert screenshots',
        error: error?.message || String(error)
      });
    }
  });

  // Single endpoint for frontend: alert + screenshots + videos
  router.get('/alerts/:id/media', async (req, res) => {
    const { id } = req.params;
    const ensureMedia = String(req.query.ensureMedia ?? 'false').toLowerCase() === 'true';
    const strictThresholdSeconds = Math.max(1, Math.min(60, Number(req.query.thresholdSeconds || process.env.ALERT_SCREENSHOT_THRESHOLD_SECONDS || 10)));

    try {
      const row = await loadAlertRow(id);
      if (!row) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      const linked = await backfillAlertMediaLinks(id, row);
      let ensureInfo: any = null;
      if (ensureMedia) {
        try {
          ensureInfo = await ensureAlertMediaRequested(
            id,
            String(row.device_id || ''),
            Number(row.channel || 1),
            new Date(row.timestamp)
          );
        } catch {}
      }

      const db = require('../storage/database');
      const alertTs = new Date(row.timestamp);
      await ensureAccurateAlertScreenshots(id, String(row.device_id || ''), Number(row.channel || 1), alertTs);
      const fallbackFrom = new Date(alertTs.getTime() - 120 * 1000);
      const fallbackTo = new Date(alertTs.getTime() + 120 * 1000);
      const [screensResult, videosResult] = await Promise.all([
        db.query(
          `WITH direct AS (
             SELECT id, device_id, channel, storage_url, file_size, timestamp, alert_id
             FROM images
             WHERE alert_id = $1
           ),
           fallback AS (
             SELECT id, device_id, channel, storage_url, file_size, timestamp, alert_id
             FROM images
             WHERE alert_id IS NULL
               AND device_id = $2
               AND timestamp BETWEEN $3 AND $4
               AND channel BETWEEN GREATEST($5 - 1, 1) AND ($5 + 1)
           )
           SELECT DISTINCT ON (id) id, device_id, channel, storage_url, file_size, timestamp, alert_id
           FROM (
             SELECT * FROM direct
             UNION ALL
             SELECT * FROM fallback
           ) q
           ORDER BY id, timestamp DESC
           LIMIT 100`,
          [id, row.device_id, fallbackFrom, fallbackTo, Number(row.channel || 1)]
        ),
        db.query(
          `WITH direct AS (
             SELECT id, device_id, channel, video_type, file_path, storage_url, file_size, start_time, end_time, duration_seconds, created_at, alert_id
             FROM videos
             WHERE alert_id = $1
           ),
           fallback AS (
             SELECT id, device_id, channel, video_type, file_path, storage_url, file_size, start_time, end_time, duration_seconds, created_at, alert_id
             FROM videos
             WHERE alert_id IS NULL
               AND device_id = $2
               AND start_time BETWEEN $3 AND $4
               AND channel BETWEEN GREATEST($5 - 1, 1) AND ($5 + 1)
           )
           SELECT DISTINCT ON (id)
             id, device_id, channel, video_type, file_path, storage_url, file_size, start_time, end_time, duration_seconds, created_at, alert_id
           FROM (
             SELECT * FROM direct
             UNION ALL
             SELECT * FROM fallback
           ) q
           ORDER BY id, start_time DESC`,
          [id, row.device_id, fallbackFrom, fallbackTo, Number(row.channel || 1)]
        )
      ]);

      const metadata = parseAlertMetadata(row.metadata);
      const videoClips = metadata?.videoClips || {};

      const screenshots = screensResult.rows.map((img: any) => {
        const ts = new Date(img.timestamp);
        return {
          id: img.id,
          alertId: img.alert_id || id,
          vehicleId: img.device_id,
          channel: Number(img.channel || 1),
          timestamp: img.timestamp,
          fileSize: Number(img.file_size || 0),
          url: normalizePublicImageUrl(img),
          offsetSeconds: Number.isNaN(ts.getTime())
            ? null
            : Number(((ts.getTime() - alertTs.getTime()) / 1000).toFixed(3))
        };
      }).sort((a: any, b: any) => {
        const aDirect = String(a.alertId || '') === id ? 0 : 1;
        const bDirect = String(b.alertId || '') === id ? 0 : 1;
        if (aDirect !== bDirect) return aDirect - bDirect;
        return Math.abs(Number(a.offsetSeconds ?? Number.MAX_SAFE_INTEGER))
          - Math.abs(Number(b.offsetSeconds ?? Number.MAX_SAFE_INTEGER));
      }).filter((shot: any) => Math.abs(Number(shot.offsetSeconds ?? Number.MAX_SAFE_INTEGER)) <= strictThresholdSeconds);
      const videos = videosResult.rows.map((v: any) => ({
        id: v.id,
        alertId: v.alert_id || id,
        vehicleId: v.device_id,
        channel: Number(v.channel || 1),
        type: v.video_type,
        timestamp: v.start_time,
        duration: Number(v.duration_seconds || 0),
        fileSize: Number(v.file_size || 0),
        filePath: v.file_path,
        url: normalizePublicVideoUrl(v.storage_url || v.file_path, buildStoredVideoUrl(v.id))
      }));

      return res.json({
        success: true,
        data: {
          alert: withAlertMediaLinks({
            id: row.id,
            vehicleId: row.device_id,
            channel: row.channel,
            type: row.alert_type,
            priority: row.priority,
            status: row.status,
            timestamp: row.timestamp,
            metadata
          }),
          screenshots,
          videos,
          clipUrls: {
            pre: `/api/alerts/${encodeURIComponent(id)}/video/pre`,
            post: `/api/alerts/${encodeURIComponent(id)}/video/post`,
            camera: `/api/alerts/${encodeURIComponent(id)}/video/camera`,
            preRaw: normalizePublicVideoUrl(videoClips.preStorageUrl || videoClips.pre, `/api/alerts/${encodeURIComponent(id)}/video/pre`),
            postRaw: normalizePublicVideoUrl(videoClips.postStorageUrl || videoClips.post, `/api/alerts/${encodeURIComponent(id)}/video/post`)
          },
          ensure: ensureInfo,
          linked,
          screenshotThresholdSeconds: strictThresholdSeconds
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch alert media',
        error: error?.message || String(error)
      });
    }
  });

  // Get alert by ID
  router.get('/alerts/:id', async (req, res) => {
    const { id } = req.params;
    const alertManager = tcpServer.getAlertManager();
    let alert: any = alertManager.getAlertById(id);

    if (!alert) {
      try {
        const dbAlert = await dbQuery(
          `SELECT id, device_id, channel, alert_type, priority, status, resolved, timestamp, latitude, longitude, metadata,
                  resolution_notes, resolved_by, resolved_at,
                  closure_type, closure_subtype,
                  resolution_reason_code, resolution_reason_label,
                  ncr_document_url, ncr_document_name,
                  report_document_url, report_document_name, report_document_type,
                  is_false_alert, false_alert_reason, false_alert_reason_code
           FROM alerts
           WHERE id = $1`,
          [id]
        );
        if (dbAlert.rows.length > 0) {
          const row = dbAlert.rows[0];
          const parsedMeta = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
          const v = parsedMeta?.vehicle || {};
          alert = {
            id: row.id,
            vehicleId: row.device_id,
            channel: row.channel,
            type: row.alert_type,
            priority: row.priority,
            status: row.status,
            resolved: !!row.resolved,
            timestamp: row.timestamp,
            location: (Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)))
              ? { latitude: Number(row.latitude), longitude: Number(row.longitude) }
              : (parsedMeta?.locationFix || null),
            vehicle: {
              vehicleId: row.device_id,
              terminalPhone: v?.terminalPhone || row.device_id || null,
              plateNumber: v?.plateNumber || null,
              plateColor: v?.plateColor ?? null,
              manufacturerId: v?.manufacturerId || null,
              terminalModel: v?.terminalModel || null,
              terminalId: v?.terminalId || null
            },
            metadata: parsedMeta,
            resolution_notes: row.resolution_notes,
            resolved_by: row.resolved_by,
            resolved_at: row.resolved_at,
            closure_type: row.closure_type,
            closure_subtype: row.closure_subtype,
            resolution_reason_code: row.resolution_reason_code,
            resolution_reason_label: row.resolution_reason_label,
            ncr_document_url: row.ncr_document_url,
            ncr_document_name: row.ncr_document_name,
            report_document_url: row.report_document_url,
            report_document_name: row.report_document_name,
            report_document_type: row.report_document_type,
            is_false_alert: !!row.is_false_alert,
            false_alert_reason: row.false_alert_reason,
            false_alert_reason_code: row.false_alert_reason_code
          };
        }
      } catch {}
    }

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: `Alert ${id} not found`
      });
    }

    const rowForLink = await loadAlertRow(id);
    const linked = rowForLink ? await backfillAlertMediaLinks(id, rowForLink) : { screenshotsLinked: 0, videosLinked: 0 };

    const ensureMedia = String(req.query?.ensureMedia ?? 'false').toLowerCase() === 'true';
    let ensureInfo: any = null;
    if (ensureMedia) {
      try {
        const vehicleId = String(alert.vehicleId || alert.device_id || '');
        const channel = Number(alert.channel || 1);
        const ts = new Date(alert.timestamp);
        if (vehicleId && Number.isFinite(ts.getTime())) {
          ensureInfo = await ensureAlertMediaRequested(id, vehicleId, channel, ts);
        }
      } catch {}
    }

    // Get associated screenshots (strict by alert_id, then fallback by same vehicle/time window)
    try {
      const db = require('../storage/database');
      const alertTs = new Date(alert.timestamp);
      const fallbackFrom = new Date(alertTs.getTime() - 90 * 1000);
      const fallbackTo = new Date(alertTs.getTime() + 90 * 1000);
      const alertVehicleId = String(alert.vehicleId || alert.device_id || '');
      const alertChannel = Number(alert.channel || 1);

      const screenshots = await db.query(
        `WITH direct AS (
           SELECT id, device_id, channel, storage_url, timestamp, alert_id
           FROM images
           WHERE alert_id = $1
         ),
         fallback AS (
           SELECT id, device_id, channel, storage_url, timestamp, alert_id
           FROM images
           WHERE alert_id IS NULL
             AND device_id = $2
             AND timestamp BETWEEN $3 AND $4
             AND channel BETWEEN GREATEST($5 - 1, 1) AND ($5 + 1)
         )
         SELECT DISTINCT ON (id) id, device_id, channel, storage_url, timestamp, alert_id
         FROM (
           SELECT * FROM direct
           UNION ALL
           SELECT * FROM fallback
         ) q
         ORDER BY id, timestamp ASC`,
        [id, alertVehicleId, fallbackFrom, fallbackTo, alertChannel]
      );

      res.json({
        success: true,
        alert: {
          ...withAlertMediaLinks(alert),
          videoUrl: normalizePublicVideoUrl(
            `/api/alerts/${encodeURIComponent(id)}/video/pre`,
            `/api/alerts/${encodeURIComponent(id)}/video/pre`
          ),
          preIncidentVideoUrl: `/api/alerts/${encodeURIComponent(id)}/video/pre`,
          postIncidentVideoUrl: `/api/alerts/${encodeURIComponent(id)}/video/post`,
          cameraVideoUrl: `/api/alerts/${encodeURIComponent(id)}/video/camera`,
          preIncidentRawUrl: normalizePublicVideoUrl(
            alert?.metadata?.videoClips?.preStorageUrl || alert?.metadata?.videoClips?.pre,
            `/api/alerts/${encodeURIComponent(id)}/video/pre`
          ),
          postIncidentRawUrl: normalizePublicVideoUrl(
            alert?.metadata?.videoClips?.postStorageUrl || alert?.metadata?.videoClips?.post,
            `/api/alerts/${encodeURIComponent(id)}/video/post`
          ),
	          preIncidentReady: !!(
              alert?.metadata?.videoClips?.pre ||
              alert?.metadata?.videoClips?.preStorageUrl
            ),
          postIncidentReady: !!(
            alert?.metadata?.videoClips?.post ||
            alert?.metadata?.videoClips?.postStorageUrl
          ),
          screenshots: screenshots.rows.map((img: any) => ({
            ...img,
            url: normalizePublicImageUrl(img),
            storage_url: normalizePublicImageUrl(img)
          }))
        },
        ensure: ensureInfo,
        linked
      });
    } catch (error) {
      res.json({
        success: true,
        alert: {
          ...withAlertMediaLinks(alert),
          videoUrl: normalizePublicVideoUrl(
            `/api/alerts/${encodeURIComponent(id)}/video/pre`,
            `/api/alerts/${encodeURIComponent(id)}/video/pre`
          ),
          preIncidentVideoUrl: `/api/alerts/${encodeURIComponent(id)}/video/pre`,
          postIncidentVideoUrl: `/api/alerts/${encodeURIComponent(id)}/video/post`,
          cameraVideoUrl: `/api/alerts/${encodeURIComponent(id)}/video/camera`,
          preIncidentRawUrl: normalizePublicVideoUrl(
            alert?.metadata?.videoClips?.preStorageUrl || alert?.metadata?.videoClips?.pre,
            `/api/alerts/${encodeURIComponent(id)}/video/pre`
          ),
          postIncidentRawUrl: normalizePublicVideoUrl(
            alert?.metadata?.videoClips?.postStorageUrl || alert?.metadata?.videoClips?.post,
            `/api/alerts/${encodeURIComponent(id)}/video/post`
          ),
	          preIncidentReady: !!(
              alert?.metadata?.videoClips?.pre ||
              alert?.metadata?.videoClips?.preStorageUrl
            ),
	          postIncidentReady: !!(
              alert?.metadata?.videoClips?.post ||
              alert?.metadata?.videoClips?.postStorageUrl
            )
        },
        ensure: ensureInfo,
        linked
      });
    }
  });

  router.get('/protocol/vendor-alert-codes', (_req, res) => {
    const catalog = tcpServer.getVendorAlertCatalog();
    res.json({
      success: true,
      count: catalog.length,
      strictMode: String(process.env.ALERT_MODE || 'strict').trim().toLowerCase() === 'strict',
      data: catalog
    });
  });

  router.get('/protocol/vendor-alert-telemetry', (_req, res) => {
    res.json({
      success: true,
      data: tcpServer.getVendorAlertTelemetry()
    });
  });

  router.get('/protocol/vendor-alert-review', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 500));
      const rows = await dbQuery(
        `SELECT id, device_id, channel, alert_type, priority, status, timestamp, latitude, longitude, metadata,
                is_false_alert, false_alert_reason, false_alert_reason_code
         FROM alerts
         WHERE (metadata->>'vendorCodeMapped')::boolean = true
            OR metadata ? 'alarmCode'
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit]
      );

      const review = rows.rows.map((row: any) => {
        const metadata = parseAlertMetadata(row.metadata);
        return {
          id: row.id,
          vehicleId: row.device_id,
          channel: row.channel,
          type: row.alert_type,
          priority: row.priority,
          status: row.status,
          timestamp: row.timestamp,
          alarmCode: metadata.alarmCode ?? null,
          sourceMessageId: metadata.sourceMessageId ?? null,
          sourceType: metadata.sourceType ?? null,
          extractionMethod: metadata.extractionMethod ?? null,
          confidence: metadata.confidence ?? null,
          domain: metadata.domain ?? null,
          isFalseAlert: !!row.is_false_alert,
          falseAlertReason: row.false_alert_reason || null,
          falseAlertReasonCode: row.false_alert_reason_code || null
        };
      });

      const falsePositives = review.filter((r: any) => r.isFalseAlert).length;
      res.json({
        success: true,
        count: review.length,
        falsePositiveCount: falsePositives,
        falsePositiveRate: review.length ? Number((falsePositives / review.length).toFixed(4)) : 0,
        data: review
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to load vendor alert review',
        error: error?.message || String(error)
      });
    }
  });

  router.get('/protocol/alert-decode-review', async (req, res) => {
    try {
      const vehicleId = String(req.query.vehicleId || '').trim();
      const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 500));
      const messageIdRaw = String(req.query.messageId || req.query.messageIdHex || '').trim().toLowerCase();
      const onlyWithSignals = String(req.query.onlyWithSignals || '').trim().toLowerCase() === 'true';
      const messageId = messageIdRaw
        ? (messageIdRaw.startsWith('0x') ? parseInt(messageIdRaw, 16) : parseInt(messageIdRaw, 10))
        : undefined;

      const traces = tcpServer.getRecentMessageTraces({
        vehicleId: vehicleId || undefined,
        messageId: Number.isFinite(messageId as number) ? messageId : undefined,
        limit
      });

      const vehicleIds = Array.from(new Set(traces.map((trace: any) => String(trace.vehicleId || '').trim()).filter(Boolean)));
      let linkedAlertsByVehicle = new Map<string, any[]>();
      if (vehicleIds.length) {
        const rows = await dbQuery(
          `SELECT id, device_id, channel, alert_type, priority, status, timestamp, metadata
           FROM alerts
           WHERE device_id = ANY($1::text[])
             AND timestamp >= NOW() - INTERVAL '48 hours'
           ORDER BY timestamp DESC
           LIMIT 2000`,
          [vehicleIds]
        );
        linkedAlertsByVehicle = rows.rows.reduce((acc: Map<string, any[]>, row: any) => {
          const key = String(row.device_id || '').trim();
          const list = acc.get(key) || [];
          list.push({
            id: row.id,
            channel: row.channel,
            type: row.alert_type,
            priority: row.priority,
            status: row.status,
            timestamp: row.timestamp,
            metadata: parseAlertMetadata(row.metadata)
          });
          acc.set(key, list);
          return acc;
        }, new Map<string, any[]>());
      }

      const review = traces.map((trace: any) => {
        const parse = trace.parse || {};
        const parsedAlert = parse.parsedAlert || null;
        const nativeSignals = extractNativeSignalsFromParsedAlert(parsedAlert);
        const parsedVendorAlerts = Array.isArray(parse.parsedAlerts) ? parse.parsedAlerts : [];
        const itemDiagnostics = Array.isArray(parse.itemDiagnostics) ? parse.itemDiagnostics : [];
        const resourceList = parse.resourceList || null;
        const resourceListSignals = extractSignalsFromResourceList(resourceList);
        const batchNativeSignals = itemDiagnostics.flatMap((item: any) => extractNativeSignalsFromParsedAlert(item?.parsedAlert || null));
        const nearbyAlerts = (linkedAlertsByVehicle.get(String(trace.vehicleId || '').trim()) || [])
          .filter((alert: any) => {
            const traceTs = new Date(trace.receivedAt).getTime();
            const alertTs = new Date(alert.timestamp).getTime();
            return Number.isFinite(traceTs) && Number.isFinite(alertTs) && Math.abs(traceTs - alertTs) <= 120000;
          })
          .slice(0, 10)
          .map((alert: any) => ({
            id: alert.id,
            type: alert.type,
            priority: alert.priority,
            status: alert.status,
            channel: alert.channel,
            timestamp: alert.timestamp,
            sourceMessageId: alert.metadata?.sourceMessageId || null,
            alertSignals: alert.metadata?.alertSignals || []
          }));

        const emittedSignals = Array.from(
          new Set([
            ...nativeSignals,
            ...batchNativeSignals,
            ...resourceListSignals,
            ...parsedVendorAlerts.map((item: any) => String(item.signalCode || '').trim()).filter(Boolean)
          ])
        );

        return {
          id: trace.id,
          receivedAt: trace.receivedAt,
          vehicleId: trace.vehicleId,
          messageId: trace.messageId,
          messageIdHex: trace.messageIdHex,
          parser: parse.parser || null,
          parseSuccess: typeof parse.parseSuccess === 'boolean' ? parse.parseSuccess : null,
          sourceShape: classifyTraceSourceShape(trace, parse),
          additionalInfo: parse.additionalInfo || [],
          parsedAlert: parsedAlert,
          resourceList,
          resourceListSignals,
          batchItems: itemDiagnostics.map((item: any) => ({
            index: item.index,
            parseSuccess: !!item.parseSuccess,
            additionalInfo: item.additionalInfo || [],
            nativeSignals: extractNativeSignalsFromParsedAlert(item?.parsedAlert || null),
            parsedAlert: item.parsedAlert || null
          })),
          passThroughType: parse.passThroughTypeHex || null,
          parsedVendorAlerts,
          emittedSignals,
          nearbyAlerts
        };
      }).filter((item: any) => !onlyWithSignals || item.emittedSignals.length > 0);

      const byMessageId = review.reduce((acc: Record<string, number>, item: any) => {
        const key = item.messageIdHex || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      res.json({
        success: true,
        count: review.length,
        filters: {
          vehicleId: vehicleId || null,
          messageId: Number.isFinite(messageId as number) ? messageId : null,
          messageIdHex: Number.isFinite(messageId as number) ? `0x${Number(messageId).toString(16).padStart(4, '0')}` : null,
          limit,
          onlyWithSignals
        },
        summary: {
          byMessageId
        },
        data: review
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to build alert decode review',
        error: error?.message || String(error)
      });
    }
  });

  // Serve screenshot by image row id (local fallback when storage URL is missing/failed)
  router.get('/images/:id/file', async (req, res) => {
    const { id } = req.params;
    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT id, file_path, storage_url FROM images WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Image not found' });
      }
      const row = result.rows[0];

      // If a valid http URL exists, redirect to it.
      const external = String(row.storage_url || '').trim();
      if (external && /^https?:\/\//i.test(external)) {
        return res.redirect(external);
      }

      const rawFilePath = String(row.file_path || '').trim();
      const rel = rawFilePath.replace(/^\/+/, '');
      const localPath = path.isAbsolute(rawFilePath)
        ? rawFilePath
        : rel.startsWith(`media${path.sep}images${path.sep}`) || rel.startsWith('media/images/')
          ? path.join(process.cwd(), rel)
          : path.join(process.cwd(), 'media', 'images', rel);
      if (!fs.existsSync(localPath)) {
        return res.status(404).json({ success: false, message: 'Local image file not found' });
      }

      const ext = path.extname(localPath).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') res.setHeader('Content-Type', 'image/jpeg');
      if (ext === '.png') res.setHeader('Content-Type', 'image/png');
      return res.sendFile(path.resolve(localPath));
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to serve image file',
        error: error?.message || String(error)
      });
    }
  });

  // Serve stored video row by id. Local raw clips are transcoded to playable MP4 on demand.
  router.get('/videos/:id/file', async (req, res) => {
    const { id } = req.params;
    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT id, file_path, storage_url, device_id, channel, start_time, video_type
         FROM videos
         WHERE id = $1
         LIMIT 1`,
        [id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Video not found' });
      }
      const row = result.rows[0];

      const external = String(row.storage_url || '').trim();
      if (external && /^https?:\/\//i.test(external)) {
        let playable = external;
        try {
          playable = await toPlayableMp4FromHttp(external, `video:${id}`);
        } catch {}
        if (/^https?:\/\//i.test(playable)) {
          return res.redirect(playable);
        }
        res.setHeader('Content-Type', /\.mp4$/i.test(playable) ? 'video/mp4' : 'video/h264');
        return res.sendFile(path.resolve(playable));
      }

      const rawFilePath = String(row.file_path || '').trim();
      if (!rawFilePath) {
        return res.status(404).json({ success: false, message: 'Video file path missing' });
      }
      const localPath = path.isAbsolute(rawFilePath)
        ? rawFilePath
        : path.join(process.cwd(), rawFilePath);
      if (!fs.existsSync(localPath)) {
        return res.status(404).json({ success: false, message: 'Local video file not found' });
      }

      let playablePath = localPath;
      let contentType = 'video/mp4';
      try {
        playablePath = await toPlayableMp4(localPath);
      } catch {
        contentType = /\.mp4$/i.test(localPath) ? 'video/mp4' : 'video/h264';
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${row.device_id || 'video'}_ch${row.channel || 1}_${id}${contentType === 'video/mp4' ? '.mp4' : '.h264'}"`
      );
      return res.sendFile(path.resolve(playablePath));
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to serve stored video',
        error: error?.message || String(error)
      });
    }
  });

  // Acknowledge alert
  router.post('/alerts/:id/acknowledge', async (req, res) => {
    const { id } = req.params;
    const alertManager = tcpServer.getAlertManager();
    const success = await alertManager.acknowledgeAlert(id);

    if (success) {
      res.json({
        success: true,
        message: `Alert ${id} acknowledged`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Alert ${id} not found or already acknowledged`
      });
    }
  });

  // Resolve alert
  router.post('/alerts/:id/resolve', async (req, res) => {
    const { id } = req.params;
    const alertManager = tcpServer.getAlertManager();
    const success = await alertManager.resolveAlert(id);

    if (success) {
      res.json({
        success: true,
        message: `Alert ${id} resolved`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Alert ${id} not found`
      });
    }
  });

  // Manually escalate alert
  router.post('/alerts/:id/escalate', async (req, res) => {
    const { id } = req.params;
    const alertManager = tcpServer.getAlertManager();
    const success = await alertManager.escalateAlert(id);

    if (success) {
      res.json({
        success: true,
        message: `Alert ${id} escalated`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Alert ${id} not found`
      });
    }
  });

  // Get video clip for alert
  router.get('/alerts/:id/video', (req, res) => {
    const { id } = req.params;
    const alertManager = tcpServer.getAlertManager();
    const alert = alertManager.getAlertById(id);

    if (!alert || !alert.videoClipPath) {
      return res.status(404).json({
        success: false,
        message: 'Video clip not found'
      });
    }

    if (require('fs').existsSync(alert.videoClipPath)) {
      res.sendFile(path.resolve(alert.videoClipPath));
    } else {
      res.status(404).json({
        success: false,
        message: 'Video file not found on disk'
      });
    }
  });

  // Get playable video clip for alert by type (pre/post/camera)
  router.get('/alerts/:id/video/:type', async (req, res) => {
    const { id } = req.params;
    const rawType = String(req.params.type || '').toLowerCase();
    const type = rawType === 'pre' || rawType === 'post' || rawType === 'camera'
      ? (rawType as 'pre' | 'post' | 'camera')
      : null;

    if (!type) {
      return res.status(400).json({
        success: false,
        message: 'Invalid type. Use pre, post, or camera'
      });
    }

    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT id, device_id, channel, timestamp, metadata FROM alerts WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      const rawMeta = result.rows[0].metadata;
      const metadata = typeof rawMeta === 'string' ? JSON.parse(rawMeta || '{}') : (rawMeta || {});
      const videoClips = metadata?.videoClips || {};
      const source = resolveAlertClipSource(videoClips, type);
      const fpsHint = getAlertClipFpsHint(videoClips, type);
      const rawVehicle = String(result.rows[0].device_id || '').trim();
      const rawChannel = Number(result.rows[0].channel || 1);
      const channel = Number.isFinite(rawChannel) && rawChannel > 0 ? rawChannel : 1;
      const alertTs = new Date(result.rows[0]?.timestamp);
      const fallbackStart = Number.isNaN(alertTs.getTime())
        ? new Date(Date.now() - 30 * 1000)
        : new Date(alertTs.getTime() - 30 * 1000);
      const fallbackEnd = Number.isNaN(alertTs.getTime())
        ? new Date(Date.now() + 30 * 1000)
        : new Date(alertTs.getTime() + 30 * 1000);

      if (!source) {
        if (rawVehicle) {
          try {
            const rows = await queryStoredVideoSegments(rawVehicle, channel, fallbackStart, fallbackEnd);
            const activeChannelRows = rows.filter((row: any) => Number(row?.channel || channel) === channel);
            const segmentRows = activeChannelRows.length ? activeChannelRows : rows;
            if (segmentRows.length > 0) {
              const job = buildStoredWindowVideoJob(rawVehicle, channel, fallbackStart, fallbackEnd, segmentRows, {
                alertId: id
              });
              return res.redirect(`/api/videos/jobs/${encodeURIComponent(job.id)}/file`);
            }
          } catch (fallbackErr) {
            console.error(`Failed fallback local window for alert ${id} ${type}:`, fallbackErr);
          }
        }

        const liveChannel = Number.isFinite(rawChannel) && rawChannel > 0 ? rawChannel : 1;
        const liveStarted = rawVehicle ? startLiveStreamForVehicle(rawVehicle, liveChannel) : false;
        if (rawVehicle && !liveStarted) {
          return res.status(409).json({
            success: false,
            message: `${type} clip missing and live stream is not available`,
            fallback: {
              type: 'live',
              vehicleId: rawVehicle,
              channel: liveChannel,
              streamStarted: liveStarted,
              streamUrl: buildStreamUrl(rawVehicle, liveChannel)
            }
          });
        }
        return res.redirect(buildStreamUrl(rawVehicle || '0', liveChannel));
      }

      if (/^https?:\/\//i.test(source)) {
        let playablePath: string = source;
        let contentType = 'video/mp4';
        try {
          playablePath = await toPlayableMp4FromHttp(source, `${id}:${type}`);
        } catch (transcodeErr) {
          console.error(`HTTP transcode failed for alert ${id} ${type}:`, transcodeErr);
          playablePath = source;
          contentType = /\.mp4(?:$|\?)/i.test(source) ? 'video/mp4' : 'video/h264';
        }
        if (/^https?:\/\//i.test(playablePath)) {
          return res.redirect(playablePath);
        }
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${id}_${type}${contentType === 'video/mp4' ? '.mp4' : '.h264'}"`);
        return res.sendFile(path.resolve(playablePath));
      }
      if (source.startsWith('/api/')) {
        return res.redirect(source);
      }

      const sourcePath = path.isAbsolute(source)
        ? source
        : path.join(process.cwd(), source);
      if (!fs.existsSync(sourcePath)) {
        return res.status(404).json({
          success: false,
          message: `Source clip missing: ${source}`
        });
      }

      let playablePath = sourcePath;
      let contentType = 'video/mp4';
      try {
        playablePath = await toPlayableMp4(sourcePath, fpsHint);
      } catch (transcodeErr) {
        console.error(`Transcode failed for alert ${id} ${type}:`, transcodeErr);
        playablePath = sourcePath;
        contentType = /\.mp4$/i.test(sourcePath) ? 'video/mp4' : 'video/h264';
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${id}_${type}${contentType === 'video/mp4' ? '.mp4' : '.h264'}"`);
      return res.sendFile(path.resolve(playablePath));
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch alert video',
        error: error?.message || String(error)
      });
    }
  });

  // Get alert history
  router.get('/alerts/:id/history', async (req, res) => {
    const { id } = req.params;
    try {
      const db = require('../storage/database');

      // Get alert and its history from database
      const [alertResult, historyResult, resolutionEventsResult] = await Promise.all([
        db.query('SELECT * FROM alerts WHERE id = $1', [id]),
        db.query(
          `SELECT action_type, action_by, action_at, notes 
           FROM alert_history 
           WHERE alert_id = $1 
           ORDER BY action_at DESC`,
          [id]
        ).catch(() => ({ rows: [] })), // Table may not exist
        db.query(
          `SELECT action_type,
                  actor as action_by,
                  created_at as action_at,
                  notes,
                  reason_code,
                  reason_label,
                  closure_type,
                  document_url,
                  document_name,
                  document_type
           FROM alert_resolution_events
           WHERE alert_id = $1
           ORDER BY created_at DESC`,
          [id]
        ).catch(() => ({ rows: [] }))
      ]);

      if (alertResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      const alert = alertResult.rows[0];

      const combinedHistory = [
        ...historyResult.rows,
        ...resolutionEventsResult.rows
      ].sort((a: any, b: any) =>
        new Date(b?.action_at || 0).getTime() - new Date(a?.action_at || 0).getTime()
      );

      // Build history from alert data if no dedicated history tables are present
      const history = combinedHistory.length > 0 ? combinedHistory : [
        { action_type: 'created', action_at: alert.timestamp, notes: null },
        ...(alert.acknowledged_at ? [{ action_type: 'acknowledged', action_at: alert.acknowledged_at, notes: null }] : []),
        ...(alert.escalated_at ? [{ action_type: 'escalated', action_at: alert.escalated_at, notes: null }] : []),
        ...(alert.resolved_at ? [{ action_type: 'resolved', action_at: alert.resolved_at, notes: alert.resolution_notes }] : [])
      ];

      res.json({
        success: true,
        data: {
          alert_id: id,
          device_id: alert.device_id,
          alert_type: alert.alert_type,
          priority: alert.priority,
          status: alert.status,
          history
        }
      });
    } catch (error) {
      console.error('Error fetching alert history:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch alert history'
      });
    }
  });

  // Get all videos for alert (pre-event, post-event, camera SD)
  router.get('/alerts/:id/videos', async (req, res) => {
    const { id } = req.params;

    try {
      const db = require('../storage/database');

      // Get alert with metadata
      const alertResult = await db.query(
        `SELECT id, device_id, channel, alert_type, timestamp, metadata 
         FROM alerts WHERE id = $1`,
        [id]
      );

      if (alertResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      const alert = alertResult.rows[0];
      const linked = await backfillAlertMediaLinks(id, alert);
      const ensureMedia = String(req.query?.ensureMedia ?? 'false').toLowerCase() === 'true';
      let ensureInfo: any = null;
      if (ensureMedia) {
        try {
          const ts = new Date(alert.timestamp);
          if (Number.isFinite(ts.getTime())) {
            ensureInfo = await ensureAlertMediaRequested(id, String(alert.device_id), Number(alert.channel || 1), ts);
          }
        } catch {}
      }

      // Get linked videos from videos table; include fallback near alert time for same vehicle/channels.
      const alertTs = new Date(alert.timestamp);
      const fallbackFrom = new Date(alertTs.getTime() - 120 * 1000);
      const fallbackTo = new Date(alertTs.getTime() + 120 * 1000);
      const alertChannel = Number(alert.channel || 1);
      const videosResult = await db.query(
        `WITH direct AS (
           SELECT id, file_path, storage_url, file_size, start_time, end_time,
                  duration_seconds, video_type, created_at, alert_id, device_id, channel
           FROM videos
           WHERE alert_id = $1
         ),
         fallback AS (
           SELECT id, file_path, storage_url, file_size, start_time, end_time,
                  duration_seconds, video_type, created_at, alert_id, device_id, channel
           FROM videos
           WHERE alert_id IS NULL
             AND device_id = $2
             AND start_time BETWEEN $3 AND $4
             AND channel BETWEEN GREATEST($5 - 1, 1) AND ($5 + 1)
         )
         SELECT DISTINCT ON (id)
           id, file_path, storage_url, file_size, start_time, end_time,
           duration_seconds, video_type, created_at, alert_id, device_id, channel
         FROM (
           SELECT * FROM direct
           UNION ALL
           SELECT * FROM fallback
         ) q
         ORDER BY id, start_time ASC`,
        [id, alert.device_id, fallbackFrom, fallbackTo, alertChannel]
      );

      // Extract video paths from metadata
      const alertMetadata = parseAlertMetadata(alert.metadata);
      const videoClips = alertMetadata?.videoClips || {};

      const preDuration = Number(videoClips.preDuration || 0);
      const postDuration = Number(videoClips.postDuration || 0);
      const hasPreEvent = !!(videoClips.pre || videoClips.preStorageUrl);
      const hasPostEvent = !!(videoClips.post || videoClips.postStorageUrl);
      const hasCameraVideo = !!(
        videoClips.cameraVideo ||
        videoClips.cameraVideoLocalPath ||
        videoClips.cameraPreVideo ||
        videoClips.cameraPreVideoLocalPath ||
        videoClips.cameraPostVideo ||
        videoClips.cameraPostVideoLocalPath
      );
      const preferredSource = (hasPreEvent || hasPostEvent)
        ? 'buffer_pre_post'
        : (hasCameraVideo ? 'camera_sd' : 'none');
      const defaultSource = 'buffer_pre_post';

      res.json({
        success: true,
        alert_id: id,
        device_id: alert.device_id,
        channel: alert.channel,
        alert_type: alert.alert_type,
        timestamp: alert.timestamp,
        media_links: buildAlertMediaLinks(id),
        default_source: defaultSource,
        preferred_source: preferredSource,
        videos: {
          // Primary evidence: frame-by-frame clips from circular buffer
          pre_event: {
            path: videoClips.pre || null,
            url: `/api/alerts/${encodeURIComponent(id)}/video/pre`,
            raw_url: normalizePublicVideoUrl(
              videoClips.preStorageUrl || videoClips.pre,
              `/api/alerts/${encodeURIComponent(id)}/video/pre`
            ),
            frames: videoClips.preFrameCount || 0,
            duration: preDuration,
            description: 'Primary evidence: 30 seconds before alert (frame-by-frame from circular buffer)'
          },
          post_event: {
            path: videoClips.post || null,
            url: `/api/alerts/${encodeURIComponent(id)}/video/post`,
            raw_url: normalizePublicVideoUrl(
              videoClips.postStorageUrl || videoClips.post,
              `/api/alerts/${encodeURIComponent(id)}/video/post`
            ),
            frames: videoClips.postFrameCount || 0,
            duration: postDuration,
            description: 'Primary evidence: 30 seconds after alert (recorded frame-by-frame live)'
          },
          camera_sd: {
            path: videoClips.cameraVideo || null,
            url: `/api/alerts/${encodeURIComponent(id)}/video/camera`,
            raw_url: normalizePublicVideoUrl(
              videoClips.cameraVideo,
              `/api/alerts/${encodeURIComponent(id)}/video/camera`
            ),
            request_url: `/api/alerts/${encodeURIComponent(id)}/request-report-video`,
            description: 'Secondary evidence: retrieved from camera SD card'
          },
          camera_sd_pre: {
            path: videoClips.cameraPreVideo || null,
            raw_url: normalizePublicVideoUrl(
              videoClips.cameraPreVideo,
              `/api/alerts/${encodeURIComponent(id)}/video/camera`
            ),
            description: 'Camera SD pre-incident clip requested automatically on alert'
          },
          camera_sd_post: {
            path: videoClips.cameraPostVideo || null,
            raw_url: normalizePublicVideoUrl(
              videoClips.cameraPostVideo,
              `/api/alerts/${encodeURIComponent(id)}/video/camera`
            ),
            description: 'Camera SD post-incident clip requested automatically on alert'
          },
          // From videos table (database records)
          database_records: videosResult.rows.map((v: any) => ({
            ...v,
            url: normalizePublicVideoUrl(v.storage_url || v.file_path, buildStoredVideoUrl(v.id))
          }))
        },
        total_videos: videosResult.rows.length,
        has_pre_event: hasPreEvent,
        has_post_event: hasPostEvent,
        has_camera_video: hasCameraVideo,
        ensure: ensureInfo,
        linked
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch alert videos',
        error: error?.message || String(error)
      });
    }
  });

  // Request camera SD playback window for reporting (default: 30s before + 30s after alert)
  router.post('/alerts/:id/request-report-video', async (req, res) => {
    const { id } = req.params;
    const lookbackSeconds = Math.max(0, Math.min(600, Number(req.body?.lookbackSeconds ?? 30)));
    const forwardSeconds = Math.max(0, Math.min(600, Number(req.body?.forwardSeconds ?? 30)));
    const queryResources = req.body?.queryResources !== false;
    const requestDownload = false;

    try {
      const alertManager = tcpServer.getAlertManager();
      const inMemoryAlert = alertManager.getAlertById(id);

      let vehicleId: string | undefined = inMemoryAlert?.vehicleId;
      let channel: number = Number(inMemoryAlert?.channel ?? 1);
      let alertTimestamp: Date | undefined = inMemoryAlert?.timestamp ? new Date(inMemoryAlert.timestamp) : undefined;

      if (!vehicleId || Number.isNaN(alertTimestamp?.getTime())) {
        const db = require('../storage/database');
        const dbResult = await db.query(
          `SELECT id, device_id, channel, timestamp
           FROM alerts
           WHERE id = $1`,
          [id]
        );

        if (dbResult.rows.length === 0) {
          return res.status(404).json({
            success: false,
            message: `Alert ${id} not found`
          });
        }

        const row = dbResult.rows[0];
        vehicleId = String(row.device_id);
        channel = Number(row.channel || 1);
        alertTimestamp = new Date(row.timestamp);
      }

      if (!vehicleId || Number.isNaN(alertTimestamp!.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Alert has invalid vehicle or timestamp'
        });
      }

      const startTime = new Date(alertTimestamp!.getTime() - lookbackSeconds * 1000);
      const endTime = new Date(alertTimestamp!.getTime() + forwardSeconds * 1000);

      const targetChannels = getVehicleChannels(vehicleId, channel);
      const storedWindowSeconds = Math.max(30, lookbackSeconds + forwardSeconds + 2);
      const perChannel = await Promise.all(targetChannels.map(async (ch) => {
        const fallbackStart = new Date(startTime.getTime() - Math.max(0, storedWindowSeconds - (endTime.getTime() - startTime.getTime())));
        const fallbackEnd = new Date(endTime.getTime() + Math.max(0, storedWindowSeconds - (endTime.getTime() - startTime.getTime())));
        const rows = await queryStoredVideoSegments(vehicleId, ch, fallbackStart, fallbackEnd);
        const segmentRows = rows.filter((row: any) => Number(row?.channel || ch) === ch);
        if (segmentRows.length > 0) {
          const storageJob = buildStoredWindowVideoJob(vehicleId, ch, startTime, endTime, segmentRows, {
            alertId: id
          });
          return {
            channel: ch,
            storageAvailable: true,
            storageJob: storageJob,
            scheduled: {
              querySent: false,
              requested: false,
              queued: false,
              downloadSent: false
            },
            manualCaptureJob: null
          };
        }

        const scheduled = tcpServer.scheduleCameraReportRequests(vehicleId, ch, startTime, endTime, {
          queryResources,
          requestDownload
        });
        const manualCaptureJob = scheduled.requested
          ? buildManualVideoJob(vehicleId!, ch, startTime, endTime, { alertId: id })
          : null;
        return {
          channel: ch,
          storageAvailable: false,
          storageJob: null,
          scheduled,
          manualCaptureJob
        };
      }));

      const firstStorage =
        perChannel.find((x) => x.channel === channel && x.storageJob) ||
        perChannel.find((x) => x.storageJob);
      const queried = perChannel.some((x) => x.scheduled?.querySent);
      const requested = perChannel.some((x) => x.scheduled?.requested);
      const queued = perChannel.some((x) => x.scheduled?.queued);
      const downloadRequested = perChannel.some((x) => x.scheduled?.downloadSent);
      const manualCaptureJob = perChannel.find((x) => !!x.manualCaptureJob)?.manualCaptureJob || null;
      const fallbackChannel = Number(targetChannels?.[0]) || channel;
      const liveStarted = tcpServer.getVehicle(vehicleId)?.connected
        ? startLiveStreamForVehicle(vehicleId, fallbackChannel)
        : false;

      if (firstStorage?.storageJob) {
        return res.json({
          success: true,
          message: `Local stored window job available for alert ${id}`,
          data: {
            alertId: id,
            vehicleId,
            channel,
            playbackChannel: firstStorage.channel,
            channelsRequested: targetChannels,
            alertTimestamp: alertTimestamp!.toISOString(),
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            lookbackSeconds,
            forwardSeconds,
            queryResources,
            querySent: false,
            requestSent: false,
            requestDownload,
            downloadRequestSent: false,
            playbackSource: 'stored_window',
            playbackJobId: firstStorage.storageJob.id,
            playbackJobUrl: firstStorage.storageJob.outputUrl,
            channels: perChannel.map((entry) => ({
              channel: entry.channel,
              source: entry.storageJob ? 'stored_window' : 'live_request',
              jobId: entry.storageJob ? entry.storageJob.id : (entry.manualCaptureJob?.id || null)
            }))
          }
        });
      }

      if (!requested && !queued) {
        if (liveStarted) {
          return res.json({
            success: true,
            message: `Vehicle connected but no stored data for this window. Live fallback started for ${vehicleId} channel ${fallbackChannel}`,
            data: {
              alertId: id,
              vehicleId,
              channel: fallbackChannel,
              channelsRequested: targetChannels,
              alertTimestamp: alertTimestamp!.toISOString(),
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              lookbackSeconds,
              forwardSeconds,
              queryResources,
              querySent: queried,
              requestSent: false,
              requestDownload,
              downloadRequestSent: false,
              playbackSource: 'live_fallback',
              playbackJobId: null,
              playbackJobUrl: null,
              streamStarted: true,
              streamUrl: buildStreamUrl(vehicleId, fallbackChannel)
            }
          });
        }

        return res.status(409).json({
          success: false,
          message: `Vehicle ${vehicleId} is not connected; cannot request camera playback`,
          data: {
            alertId: id,
            vehicleId,
            channel,
            channelsRequested: targetChannels,
            alertTimestamp: alertTimestamp!.toISOString(),
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            lookbackSeconds,
            forwardSeconds,
            queryResources,
            querySent: queried,
            requestSent: false,
            requestDownload,
            downloadRequestSent: false,
            playbackJobId: manualCaptureJob?.id || null,
            playbackJobUrl: manualCaptureJob ? `/api/videos/jobs/${encodeURIComponent(manualCaptureJob.id)}/file` : null
          }
        });
      }

      if (!requested && queued) {
        return res.status(202).json({
          success: true,
          message: `Vehicle ${vehicleId} is not connected; request queued until reconnect`,
          data: {
            alertId: id,
            vehicleId,
            channel,
            channelsRequested: targetChannels,
            alertTimestamp: alertTimestamp!.toISOString(),
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            lookbackSeconds,
            forwardSeconds,
            queryResources,
            querySent: false,
            requestSent: false,
            requestQueued: true,
            requestDownload,
            downloadRequestSent: false,
            playbackJobId: null,
            playbackJobUrl: null
          }
        });
      }

      res.json({
        success: true,
        message: `Camera report-video request sent for alert ${id}`,
        data: {
          alertId: id,
          vehicleId,
          channel,
          channelsRequested: targetChannels,
          alertTimestamp: alertTimestamp!.toISOString(),
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          lookbackSeconds,
          forwardSeconds,
          queryResources,
          querySent: queried,
          requestSent: requested,
          requestDownload,
          downloadRequestSent: downloadRequested,
          playbackSource: requested || queued || manualCaptureJob ? 'manual_capture' : 'pending',
          playbackJobId: manualCaptureJob?.id || null,
          playbackJobUrl: manualCaptureJob ? `/api/videos/jobs/${encodeURIComponent(manualCaptureJob.id)}/file` : null
        }
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to request report video',
        error: error?.message
      });
    }
  });

  // TEST: Query resource list (0x9205)
  router.post('/vehicles/:id/test-query-resources', (req, res) => {
    const { id } = req.params;
    const { channel = 1, minutesBack = 5 } = req.body;

    const vehicle = tcpServer.getVehicle(id);
    if (!vehicle || !vehicle.connected) {
      return res.status(404).json({ success: false, message: 'Vehicle not connected' });
    }

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - minutesBack * 60000);

    const success = tcpServer.queryResourceList(id, channel, startTime, endTime);
    res.json({
      success,
      message: success ? 'Query sent, check logs for 0x1205 response' : 'Failed to send query'
    });
  });

  // Request arbitrary video range from camera for a vehicle/channel
  router.post('/vehicles/:id/request-video', (req, res) => {
    const { id } = req.params;
    const {
      channel = 1,
      startTime,
      endTime,
      mode = 'both',
      queryResources = true,
      recordPlayback = true
    } = req.body || {};

    const vehicle = tcpServer.getVehicle(id);
    if (!vehicle || !vehicle.connected) {
      return res.status(404).json({
        success: false,
        message: `Vehicle ${id} not connected`
      });
    }

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'startTime and endTime are required (ISO timestamp)'
      });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid startTime or endTime'
      });
    }

    if (end <= start) {
      return res.status(400).json({
        success: false,
        message: 'endTime must be after startTime'
      });
    }

    const ch = Number(channel) || 1;
    const normalizedMode = String(mode).toLowerCase();
    if ((normalizedMode === 'download' || normalizedMode === 'both') && !FTP_DOWNLOADS_ENABLED) {
      return res.status(400).json({
        success: false,
        message: 'Download mode is disabled (FTP disabled). Use mode="stream".'
      });
    }
    const wantStream = normalizedMode === 'stream' || normalizedMode === 'both';
    const wantDownload = FTP_DOWNLOADS_ENABLED && (normalizedMode === 'download' || normalizedMode === 'both');
    if (!wantStream && !wantDownload) {
      return res.status(400).json({
        success: false,
        message: 'mode must be one of: stream, download, both'
      });
    }

    const scheduled = (wantStream || wantDownload)
      ? tcpServer.scheduleCameraReportRequests(id, ch, start, end, {
          queryResources,
          requestDownload: wantDownload
        })
      : { requested: false, queued: false, querySent: false, downloadSent: false };
    const querySent = scheduled.querySent;
    const streamRequestSent = scheduled.requested;
    const downloadRequestSent = scheduled.downloadSent;
    const warnings: string[] = [];
    let playbackJobId: string | null = null;
    let playbackJobUrl: string | null = null;
    if (recordPlayback && streamRequestSent) {
      const job = buildManualVideoJob(id, ch, start, end);
      playbackJobId = job.id;
      playbackJobUrl = `/api/videos/jobs/${encodeURIComponent(job.id)}/file`;
    }

    const anySent = streamRequestSent || downloadRequestSent || querySent;
    if (!anySent) {
      return res.status(409).json({
        success: false,
        message: 'No request was sent (check connection/mode)',
        data: {
          vehicleId: id,
          channel: ch,
          mode: normalizedMode,
      querySent,
      streamRequestSent,
      downloadRequestSent,
      requestQueued: scheduled.queued,
          warnings,
          playbackJobId,
          playbackJobUrl
        }
      });
    }

    res.json({
      success: true,
      message: `Video request submitted for ${id} channel ${ch}`,
      data: {
        vehicleId: id,
        channel: ch,
        mode: normalizedMode,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        querySent,
        streamRequestSent,
        downloadRequestSent,
        warnings,
        playbackJobId,
        playbackJobUrl
      }
    });
  });

  // Query videos in a time range and return selectable clip list
  router.post('/vehicles/:id/videos/search', async (req, res) => {
    const { id } = req.params;
    const {
      channel = 1,
      startTime,
      endTime,
      waitMs = 8000
    } = req.body || {};

    const vehicle = tcpServer.getVehicle(id);
    if (!vehicle || !vehicle.connected) {
      return res.status(404).json({
        success: false,
        message: `Vehicle ${id} not connected`
      });
    }

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'startTime and endTime are required (ISO timestamp)'
      });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time range'
      });
    }

    const ch = Number(channel) || 1;
    const before = tcpServer.getLatestResourceList(id)?.receivedAt || 0;
    const querySent = tcpServer.queryResourceList(id, ch, start, end);

    const timeoutAt = Date.now() + Math.max(1000, Math.min(15000, Number(waitMs) || 8000));
    while (Date.now() < timeoutAt) {
      const latest = tcpServer.getLatestResourceList(id);
      if (latest && latest.receivedAt > before) break;
      await new Promise((r) => setTimeout(r, 350));
    }

    const latest = tcpServer.getLatestResourceList(id);
    const items = latest?.items || [];
    const filtered = items
      .filter((it) => ch <= 0 || it.channel === ch)
      .map((it, idx) => {
        const itemStart = parseResourceTime(it.startTime);
        const itemEnd = parseResourceTime(it.endTime);
        const overlaps = itemStart && itemEnd
          ? itemStart.getTime() <= end.getTime() && itemEnd.getTime() >= start.getTime()
          : false;
        return {
          id: `${it.channel}-${idx}-${it.startTime}`,
          ...it,
          overlaps
        };
      })
      .filter((it) => it.overlaps);

    res.json({
      success: true,
      message: `Found ${filtered.length} clip(s) in selected range`,
      data: {
        vehicleId: id,
        channel: ch,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        querySent,
        latestResourceReceivedAt: latest?.receivedAt || null,
        totalListed: items.length,
        clips: filtered
      }
    });
  });

  // Query locally stored videos in a time range (DB-backed recordings)
  router.get('/playback/vehicles', async (req, res) => {
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 500)));
    const days = Math.max(1, Math.min(365, Number(req.query.days || 7)));

    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT
           device_id,
           COUNT(*)::int AS clip_count,
           MIN(start_time) AS earliest_time,
           MAX(COALESCE(end_time, start_time)) AS latest_time,
           ARRAY_AGG(DISTINCT channel ORDER BY channel) AS channels
         FROM videos
         WHERE start_time >= NOW() - ($1::int * INTERVAL '1 day')
         GROUP BY device_id
         ORDER BY latest_time DESC
         LIMIT $2`,
        [days, limit]
      );

      return res.json({
        success: true,
        data: (result.rows || []).map((row: any) => ({
          vehicleId: String(row.device_id || ''),
          clipCount: Number(row.clip_count || 0),
          earliestTime: row.earliest_time,
          latestTime: row.latest_time,
          channels: Array.isArray(row.channels) ? row.channels.map((value: any) => Number(value)).filter((v: number) => Number.isFinite(v) && v > 0) : []
        }))
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to list playback vehicles',
        error: error?.message || String(error)
      });
    }
  });

  router.get('/vehicles/:id/videos/availability', async (req, res) => {
    const { id } = req.params;
    const dateRaw = String(req.query.date || '').trim();
    const requestedDate = dateRaw ? new Date(`${dateRaw}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(requestedDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date. Use YYYY-MM-DD'
      });
    }

    const startOfDay = new Date(requestedDate);
    const endOfDay = new Date(requestedDate);
    endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT id, device_id, channel, video_type, start_time, end_time, duration_seconds, file_size
         FROM videos
         WHERE device_id = $1
           AND start_time < $3
           AND COALESCE(end_time, start_time) >= $2
         ORDER BY channel ASC, start_time ASC`,
        [id, startOfDay, endOfDay]
      );

      const rows = result.rows || [];
      const byChannel = new Map<number, any[]>();
      for (const row of rows) {
        const channel = Number(row.channel || 1) || 1;
        if (!byChannel.has(channel)) byChannel.set(channel, []);
        byChannel.get(channel)!.push({
          id: row.id,
          startTime: row.start_time,
          endTime: row.end_time,
          durationSeconds: Number(row.duration_seconds || 0),
          fileSize: Number(row.file_size || 0),
          videoType: row.video_type
        });
      }

      const channels = Array.from(byChannel.entries()).map(([channel, clips]) => ({
        channel,
        clipCount: clips.length,
        earliestTime: clips[0]?.startTime || null,
        latestTime: clips[clips.length - 1]?.endTime || clips[clips.length - 1]?.startTime || null,
        clips
      }));

      return res.json({
        success: true,
        data: {
          vehicleId: id,
          date: startOfDay.toISOString().slice(0, 10),
          channels,
          totalClips: rows.length
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch playback availability',
        error: error?.message || String(error)
      });
    }
  });

  router.post('/vehicles/:id/videos/local', async (req, res) => {
    const { id } = req.params;
    const { channel = 0, startTime, endTime, limit = 200 } = req.body || {};

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'startTime and endTime are required (ISO timestamp)'
      });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time range'
      });
    }

    const ch = Number(channel) || 0;
    const maxLimit = Math.max(1, Math.min(500, Number(limit) || 200));

    try {
      const db = require('../storage/database');
      const params: any[] = [id, start, end];
      let sql = `
        SELECT id, device_id, channel, video_type, file_path, storage_url, file_size,
               start_time, end_time, duration_seconds, created_at, alert_id
        FROM videos
        WHERE device_id = $1
          AND start_time <= $3
          AND COALESCE(end_time, start_time) >= $2`;
      if (ch > 0) {
        sql += ` AND channel = $4`;
        params.push(ch);
      }
      sql += ` ORDER BY start_time ASC LIMIT ${maxLimit}`;

      const result = await db.query(sql, params);
      const videos = (result.rows || []).map((v: any) => {
        const rawPath = String(v.file_path || '').trim();
        const localPath = rawPath
          ? (path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath))
          : '';
        let sourceExists = false;
        let playableReady = false;
        try {
          if (localPath && fs.existsSync(localPath)) {
            sourceExists = true;
            const playablePath = getPlayableVariantPath(localPath);
            if (playablePath && fs.existsSync(playablePath)) {
              const outStat = fs.statSync(playablePath);
              const inStat = fs.statSync(localPath);
              if (outStat.size > 0 && outStat.mtimeMs >= inStat.mtimeMs) {
                playableReady = true;
              }
            }
            if (/\.mp4$/i.test(localPath)) {
              playableReady = true;
            }
          }
        } catch {}
        return {
          id: v.id,
          device_id: v.device_id,
          channel: v.channel,
          video_type: v.video_type,
          file_path: v.file_path,
          storage_url: v.storage_url,
          file_size: v.file_size,
          start_time: v.start_time,
          end_time: v.end_time,
          duration_seconds: v.duration_seconds,
          created_at: v.created_at,
          alert_id: v.alert_id,
          source_exists: sourceExists,
          playable_ready: playableReady,
          url: normalizePublicVideoUrl(v.storage_url || v.file_path, buildStoredVideoUrl(v.id))
        };
      });

      return res.json({
        success: true,
        message: `Found ${videos.length} local video(s)`,
        data: {
          vehicleId: id,
          channel: ch,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          count: videos.length,
          videos
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch local videos',
        error: error?.message || String(error)
      });
    }
  });

  // Build a single playable clip from locally stored recordings for an exact time window.
  router.post('/vehicles/:id/videos/window', async (req, res) => {
    const { id } = req.params;
    const { channel = 1, startTime, endTime, alertId } = req.body || {};

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'startTime and endTime are required (ISO timestamp)'
      });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time range'
      });
    }

    const ch = Number(channel) || 1;
    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT id, file_path, start_time, end_time, duration_seconds, frame_count, alert_id
         FROM videos
         WHERE device_id = $1
           AND channel = $2
           AND start_time <= $3
           AND COALESCE(end_time, start_time) >= $4
         ORDER BY start_time ASC`,
        [id, ch, end, start]
      );

      const rows = (result.rows || []).filter((row: any) => String(row?.file_path || '').trim());
      if (rows.length === 0) {
        const vehicle = tcpServer.getVehicle(id);
        const requestedChannel = Number(ch) || 1;
        if (vehicle && vehicle.connected) {
          const liveStarted = startLiveStreamForVehicle(id, requestedChannel);
          return res.status(200).json({
            success: true,
            message: `No stored local recordings found. Live stream started for ${id} channel ${requestedChannel}`,
            data: {
              vehicleId: id,
              channel: requestedChannel,
              startTime: start.toISOString(),
              endTime: end.toISOString(),
              streamUrl: buildStreamUrl(id, requestedChannel),
              streamStarted: liveStarted,
              playbackSource: 'live_fallback',
              playbackJobId: null,
              playbackJobUrl: null
            }
          });
        }

        return res.status(404).json({
          success: false,
          message: 'No stored local recordings found in selected range'
        });
      }

      const job = buildStoredWindowVideoJob(id, ch, start, end, rows, {
        alertId: String(alertId || '').trim() || undefined
      });

      return res.json({
        success: true,
        message: `Stored video window job queued for ${id} channel ${ch}`,
        data: {
          vehicleId: id,
          channel: ch,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          playbackJobId: job.id,
          playbackJobUrl: `/api/videos/jobs/${encodeURIComponent(job.id)}/file`,
          outputUrl: job.outputUrl,
          sourceSegments: rows.length
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to build local video window',
        error: error?.message || String(error)
      });
    }
  });

  // Replay local recordings over the live websocket as if live.
  router.post('/vehicles/:id/replay', async (req, res) => {
    const { id } = req.params;
    const { channel = 1, startTime, endTime, speed = 1, fps = 15 } = req.body || {};

    if (!replayService) {
      return res.status(500).json({ success: false, message: 'Replay service not available' });
    }

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'startTime and endTime are required (ISO timestamp)'
      });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time range'
      });
    }

    const ch = Number(channel) || 1;
    const speedValue = Math.max(0.25, Math.min(4, Number(speed) || 1));
    const fpsValue = Math.max(1, Math.min(30, Number(fps) || 15));

    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT id, file_path, start_time, end_time, duration_seconds
         FROM videos
         WHERE device_id = $1
           AND channel = $2
           AND start_time <= $3
           AND COALESCE(end_time, start_time) >= $4
         ORDER BY start_time ASC`,
        [id, ch, end, start]
      );

      const files = (result.rows || [])
        .map((row: any) => ({
          filePath: String(row.file_path || '').trim(),
          startTime: row.start_time ? new Date(row.start_time) : undefined,
          endTime: row.end_time ? new Date(row.end_time) : undefined,
          durationSec: Number(row.duration_seconds || 0) || null
        }))
        .filter((f: any) => f.filePath);

      if (files.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No local recordings found in selected range'
        });
      }

      const replayId = replayService.startReplay({
        vehicleId: id,
        channel: ch,
        startTime: start,
        endTime: end,
        speed: speedValue,
        fps: fpsValue
      }, files);

      return res.json({
        success: true,
        message: 'Replay started',
        data: {
          replayId,
          vehicleId: id,
          channel: ch,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          speed: speedValue,
          fps: fpsValue
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to start replay',
        error: error?.message || String(error)
      });
    }
  });

  // Kick off playable MP4 generation for a stored video
  router.post('/videos/:id/prepare', async (req, res) => {
    const { id } = req.params;
    try {
      const db = require('../storage/database');
      const result = await db.query(
        `SELECT id, file_path FROM videos WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Video not found' });
      }
      const rawPath = String(result.rows[0].file_path || '').trim();
      if (!rawPath) {
        return res.status(404).json({ success: false, message: 'Video file path missing' });
      }
      const localPath = path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath);
      if (!fs.existsSync(localPath)) {
        return res.status(404).json({ success: false, message: 'Local video file not found' });
      }
      if (/\.mp4$/i.test(localPath)) {
        return res.json({ success: true, status: 'ready' });
      }

      const playablePath = getPlayableVariantPath(localPath);
      try {
        if (playablePath && fs.existsSync(playablePath)) {
          const outStat = fs.statSync(playablePath);
          const inStat = fs.statSync(localPath);
          if (outStat.size > 0 && outStat.mtimeMs >= inStat.mtimeMs) {
            return res.json({ success: true, status: 'ready' });
          }
        }
      } catch {}

      void toPlayableMp4(localPath).catch(() => {});
      return res.json({ success: true, status: 'queued' });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to prepare video',
        error: error?.message || String(error)
      });
    }
  });

  // Get status of a manual playback capture job
  router.get('/videos/jobs', (req, res) => {
    const vehicleIdFilter = String(req.query.vehicleId || '').trim();
    const channelFilter = Number(req.query.channel || 0);
    const statusFilter = String(req.query.status || '').trim().toLowerCase();

    const jobs = Array.from(manualVideoJobs.values())
      .filter((job) => {
        if (vehicleIdFilter && job.vehicleId !== vehicleIdFilter) return false;
        if (channelFilter > 0 && job.channel !== channelFilter) return false;
        if (statusFilter && job.status !== statusFilter) return false;
        return true;
      })
      .map((job) => {
        let fileReady = false;
        let fileSize = 0;
        if (job.outputPath && fs.existsSync(job.outputPath)) {
          try {
            const st = fs.statSync(job.outputPath);
            fileReady = st.size > 0;
            fileSize = st.size || 0;
          } catch {}
        }
        return { ...job, fileReady, fileSize };
      })
      .sort((a, b) => {
        const ta = new Date(a.createdAt).getTime();
        const tb = new Date(b.createdAt).getTime();
        return tb - ta;
      });

    res.json({
      success: true,
      data: {
        count: jobs.length,
        jobs
      }
    });
  });

  // Get status of a manual playback capture job
  router.get('/videos/jobs/:id', (req, res) => {
    const { id } = req.params;
    const job = manualVideoJobs.get(id);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: `Job ${id} not found`
      });
    }
    let fileReady = false;
    let fileSize = 0;
    if (job.outputPath && fs.existsSync(job.outputPath)) {
      try {
        const st = fs.statSync(job.outputPath);
        fileReady = st.size > 0;
        fileSize = st.size || 0;
      } catch {}
    }
    res.json({
      success: true,
      data: { ...job, fileReady, fileSize }
    });
  });

  // Stream/download generated manual playback file
  router.get('/videos/jobs/:id/file', (req, res) => {
    const { id } = req.params;
    const job = manualVideoJobs.get(id);
    if (!job) {
      return res.status(404).json({ success: false, message: `Job ${id} not found` });
    }
    if (job.status !== 'completed' || !job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({
        success: false,
        message: 'Video file not ready',
        data: {
          status: job.status,
          error: job.error || null,
          outputPath: job.outputPath || null
        }
      });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(path.resolve(job.outputPath));
  });

  // TEST: Request playback (0x9201)
  router.post('/vehicles/:id/test-playback', (req, res) => {
    const { id } = req.params;
    const { channel = 1, minutesBack = 1 } = req.body;

    const vehicle = tcpServer.getVehicle(id);
    if (!vehicle || !vehicle.connected) {
      return res.status(404).json({ success: false, message: 'Vehicle not connected' });
    }

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - minutesBack * 60000);

    const success = tcpServer.requestCameraVideo(id, channel, startTime, endTime);
    res.json({
      success,
      message: success ? 'Playback request sent, check logs for RTP data' : 'Failed to send request'
    });
  });

  // TEST: Simulate alert to test 30s video capture
  router.post('/test/simulate-alert', async (req, res) => {
    const { vehicleId, channel = 1, alertType = 'fatigue', fatigueLevel = 85 } = req.body;

    if (!vehicleId) {
      return res.status(400).json({
        success: false,
        message: 'vehicleId is required. Use a vehicleId that is currently streaming video.'
      });
    }

    const alertManager = tcpServer.getAlertManager();
    const bufferStats = alertManager.getBufferStats();
    const bufferKey = `${vehicleId}_${channel}`;

    if (!bufferStats[bufferKey] || bufferStats[bufferKey].totalFrames === 0) {
      return res.status(400).json({
        success: false,
        message: `No video frames in buffer for ${bufferKey}. Start video streaming first and wait 30s for buffer to fill.`,
        bufferStats
      });
    }

    // Create a simulated location alert
    const simulatedAlert = {
      vehicleId,
      timestamp: new Date(),
      latitude: 0,
      longitude: 0,
      drivingBehavior: {
        fatigue: alertType === 'fatigue',
        phoneCall: alertType === 'phone',
        smoking: alertType === 'smoking',
        custom: 0,
        fatigueLevel: alertType === 'fatigue' ? fatigueLevel : 0
      }
    };

    // Process through alert manager
    await alertManager.processAlert(simulatedAlert as any);

    res.json({
      success: true,
      message: `Alert simulated for ${vehicleId} channel ${channel}. Check recordings/${vehicleId}/alerts/ for video clips.`,
      bufferBefore: bufferStats[bufferKey],
      note: 'Pre-event video saved immediately. Post-event video will be saved in ~35 seconds.'
    });
  });

  // Check buffer status for all streams
  router.get('/buffers/status', (req, res) => {
    const alertManager = tcpServer.getAlertManager();
    const stats = alertManager.getBufferStats();

    const summary = Object.entries(stats).map(([key, value]: [string, any]) => ({
      stream: key,
      frames: value.totalFrames,
      duration: `${value.bufferDuration?.toFixed(1) || 0}s`,
      oldest: value.oldestFrame,
      newest: value.newestFrame,
      isRecordingPostEvent: value.isRecordingPostEvent,
      postEventAlertId: value.postEventAlertId
    }));

    res.json({
      success: true,
      totalBuffers: Object.keys(stats).length,
      data: summary
    });
  });

  // === NEW REQUIREMENTS ENDPOINTS ===

  // Resolve alert with required notes
  router.post('/alerts/:id/resolve-with-notes', async (req, res) => {
    const { id } = req.params;
    const { notes, resolvedBy, ncrDocumentUrl, ncrDocumentName } = req.body;

    if (!notes || notes.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Resolution notes required (minimum 10 characters)'
      });
    }

    const alertManager = tcpServer.getAlertManager();
    const alertStorage = require('../storage/alertStorageDB');
    const storage = new alertStorage.AlertStorageDB();

    // Resolve in memory if active (best effort), and always persist in DB.
    await alertManager.resolveAlert(id, notes, resolvedBy);
    const success = await storage.resolveWithNcr(id, notes, resolvedBy, ncrDocumentUrl, ncrDocumentName);

    if (success) {
      res.json({
        success: true,
        message: `Alert ${id} resolved with NCR details`,
        data: {
          alertId: id,
          resolved: true,
          closureType: 'ncr',
          ncrDocumentUrl: ncrDocumentUrl || null,
          ncrDocumentName: ncrDocumentName || null
        }
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Alert ${id} not found`
      });
    }
  });

  // Unified close endpoint: supports notes + dropdown reason + NCR/report document metadata
  router.post('/alerts/:id/close', async (req, res) => {
    const { id } = req.params;
    const {
      closureType,
      notes,
      actor,
      reasonCode,
      reasonLabel,
      documentUrl,
      documentName,
      documentType,
      payload
    } = req.body || {};

    const normalizedClosureType = String(closureType || 'resolved').toLowerCase();
    const allowed = new Set(['resolved', 'false_alert', 'ncr', 'report']);
    if (!allowed.has(normalizedClosureType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid closureType. Use one of: resolved, false_alert, ncr, report'
      });
    }
    if (!notes || String(notes).trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: 'Resolution notes required (minimum 5 characters)'
      });
    }

    try {
      const alertStorage = require('../storage/alertStorageDB');
      const storage = new alertStorage.AlertStorageDB();
      const success = await storage.closeAlertWithDetails({
        alertId: id,
        closureType: normalizedClosureType,
        notes: String(notes).trim(),
        actor: actor || null,
        reasonCode: reasonCode || null,
        reasonLabel: reasonLabel || null,
        documentUrl: documentUrl || null,
        documentName: documentName || null,
        documentType: documentType || null,
        payload: payload || {}
      });

      // Best effort: resolve in-memory alert state too.
      try {
        const alertManager = tcpServer.getAlertManager();
        await alertManager.resolveAlert(id, String(notes).trim(), actor || undefined);
      } catch {}

      if (!success) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      return res.json({
        success: true,
        message: `Alert ${id} closed`,
        data: {
          alertId: id,
          closureType: normalizedClosureType,
          reasonCode: reasonCode || null,
          reasonLabel: reasonLabel || null,
          documentUrl: documentUrl || null,
          documentName: documentName || null,
          documentType: documentType || null
        }
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to close alert',
        error: error?.message || String(error)
      });
    }
  });

  // Mark alert as false alert
  router.post('/alerts/:id/mark-false', async (req, res) => {
    const { id } = req.params;
    const { reason, markedBy, reasonCode } = req.body;

    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Reason required (minimum 10 characters)'
      });
    }

    try {
      const alertStorage = require('../storage/alertStorageDB');
      const storage = new alertStorage.AlertStorageDB();
      const success = await storage.markAsFalseAlert(id, reason, markedBy, reasonCode);

      if (!success) {
        return res.status(404).json({
          success: false,
          message: `Alert ${id} not found`
        });
      }

      res.json({
        success: true,
        message: `Alert ${id} marked as false alert`,
        data: {
          alertId: id,
          resolved: true,
          closureType: 'false_alert',
          reasonCode: reasonCode || null
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to mark alert as false'
      });
    }
  });

  // [REMOVED] /alerts/unattended - moved before /alerts/:id
  // [REMOVED] /alerts/by-priority - moved before /alerts/:id

  // Get screenshots for review (auto-refresh endpoint)
  router.get('/screenshots/recent', async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const minutes = parseInt(req.query.minutes as string) || 30;
    const alertsOnly = req.query.alertsOnly === 'true';

    try {
      const query = alertsOnly
        ? `SELECT * FROM images WHERE alert_id IS NOT NULL AND timestamp >= NOW() - ($2 || ' minutes')::interval ORDER BY timestamp DESC LIMIT $1`
        : `SELECT * FROM images WHERE timestamp >= NOW() - ($2 || ' minutes')::interval ORDER BY timestamp DESC LIMIT $1`;

      const result = await require('../storage/database').query(query, [limit, minutes]);

      res.json({
        success: true,
        screenshots: result.rows.map((img: any) => ({
          ...img,
          url: normalizePublicImageUrl(img),
          storage_url: normalizePublicImageUrl(img)
        })),
        total: result.rows.length,
        count: result.rows.length,
        lastUpdate: new Date()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch screenshots'
      });
    }
  });

  // Executive Dashboard - Analytics
  router.get('/dashboard/executive', async (req, res) => {
    const days = parseInt(req.query.days as string) || 30;

    try {
      const db = require('../storage/database');

      const alertsByPriority = await db.query(
        `SELECT priority, COUNT(*) as count 
         FROM alerts 
         WHERE timestamp > NOW() - INTERVAL '${days} days'
         GROUP BY priority`
      );

      const alertsByType = await db.query(
        `SELECT alert_type, COUNT(*) as count 
         FROM alerts 
         WHERE timestamp > NOW() - INTERVAL '${days} days'
         GROUP BY alert_type
         ORDER BY count DESC
         LIMIT 10`
      );

      const avgResponseTime = await db.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (acknowledged_at - timestamp))) as avg_seconds
         FROM alerts 
         WHERE acknowledged_at IS NOT NULL
         AND timestamp > NOW() - INTERVAL '${days} days'`
      );

      const escalationRate = await db.query(
        `SELECT 
           COUNT(CASE WHEN escalation_level > 0 THEN 1 END)::FLOAT / NULLIF(COUNT(*), 0) * 100 as rate
         FROM alerts
         WHERE timestamp > NOW() - INTERVAL '${days} days'`
      );

      const resolutionRate = await db.query(
        `SELECT 
           COUNT(CASE WHEN status = 'resolved' THEN 1 END)::FLOAT / NULLIF(COUNT(*), 0) * 100 as rate
         FROM alerts
         WHERE timestamp > NOW() - INTERVAL '${days} days'`
      );

      res.json({
        success: true,
        period: `Last ${days} days`,
        data: {
          alertsByPriority: alertsByPriority.rows,
          alertsByType: alertsByType.rows,
          avgResponseTimeSeconds: parseFloat(avgResponseTime.rows[0]?.avg_seconds || 0).toFixed(2),
          escalationRate: parseFloat(escalationRate.rows[0]?.rate || 0).toFixed(2) + '%',
          resolutionRate: parseFloat(resolutionRate.rows[0]?.rate || 0).toFixed(2) + '%'
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch dashboard data'
      });
    }
  });

  // Record speeding event
  router.post('/speeding/record', async (req, res) => {
    const { vehicleId, driverId, speed, speedLimit, latitude, longitude } = req.body;

    if (!vehicleId || !speed || !speedLimit) {
      return res.status(400).json({
        success: false,
        message: 'vehicleId, speed, and speedLimit are required'
      });
    }

    try {
      const eventId = await speedingManager.recordSpeedingEvent(
        vehicleId,
        driverId || null,
        speed,
        speedLimit,
        { latitude: latitude || 0, longitude: longitude || 0 }
      );

      res.json({
        success: true,
        eventId,
        message: 'Speeding event recorded'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to record speeding event'
      });
    }
  });

  // Get driver rating
  router.get('/drivers/:driverId/rating', async (req, res) => {
    const { driverId } = req.params;

    try {
      const result = await require('../storage/database').query(
        `SELECT * FROM drivers WHERE driver_id = $1`,
        [driverId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Driver not found'
        });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch driver rating'
      });
    }
  });

  // Get speeding events for driver
  router.get('/drivers/:driverId/speeding-events', async (req, res) => {
    const { driverId } = req.params;
    const days = parseInt(req.query.days as string) || 7;

    try {
      const result = await require('../storage/database').query(
        `SELECT * FROM speeding_events 
         WHERE driver_id = $1 AND timestamp > NOW() - INTERVAL '${days} days'
         ORDER BY timestamp DESC`,
        [driverId]
      );

      res.json({
        success: true,
        period: `Last ${days} days`,
        total: result.rows.length,
        data: result.rows
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch speeding events'
      });
    }
  });

  return router;
}
