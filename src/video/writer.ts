import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { VideoStorage } from '../storage/videoStorage';

export class VideoWriter {
  private static shutdownHooksRegistered = false;
  private static activeInstances = new Set<VideoWriter>();
  private fileStreams = new Map<string, fs.WriteStream>();
  private frameCounters = new Map<string, number>();
  private videoStorage = new VideoStorage();
  private videoIds = new Map<string, string>();
  private startTimes = new Map<string, Date>();
  private filePaths = new Map<string, string>();
  private bytesWritten = new Map<string, number>();
  private lastPersistTimes = new Map<string, number>();
  private readonly segmentDurationMs = Math.max(10_000, Number(process.env.LIVE_SEGMENT_SECONDS || 60) * 1000);
  private readonly progressUpdateMs = Math.max(1000, Number(process.env.VIDEO_PROGRESS_UPDATE_MS || 5000));
  private readonly rotationCheckMs = Math.max(2_000, Math.min(10_000, Number(process.env.VIDEO_ROTATION_CHECK_MS || Math.floor(this.segmentDurationMs / 2))));
  private readonly minValidSegmentBytes = Math.max(64 * 1024, Number(process.env.MIN_VALID_SEGMENT_BYTES || 256 * 1024));
  private pendingTranscodes = new Set<string>();
  private readonly rotationTimer: NodeJS.Timeout;

  constructor() {
    VideoWriter.activeInstances.add(this);
    this.registerShutdownHooks();
    this.rotationTimer = setInterval(() => {
      this.rotateExpiredSegments();
    }, this.rotationCheckMs);
    this.rotationTimer.unref?.();
  }

  private registerShutdownHooks(): void {
    if (VideoWriter.shutdownHooksRegistered) return;
    const flushAll = () => {
      for (const instance of VideoWriter.activeInstances) {
        try {
          instance.stopAllRecordings();
        } catch {}
      }
    };
    process.on('SIGINT', flushAll);
    process.on('SIGTERM', flushAll);
    process.on('beforeExit', flushAll);
    VideoWriter.shutdownHooksRegistered = true;
  }

  private getFfmpegBinary(): string {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const installer = require('@ffmpeg-installer/ffmpeg');
      if (installer?.path) return installer.path;
    } catch {}
    return 'ffmpeg';
  }

  private kickoffPlayableTranscode(sourcePath: string): void {
    if (!sourcePath || /\.mp4$/i.test(sourcePath)) return;
    if (!fs.existsSync(sourcePath)) return;

    const parsed = path.parse(sourcePath);
    const outputPath = path.join(parsed.dir, `${parsed.name}.playable.mp4`);

    try {
      if (fs.existsSync(outputPath)) {
        const outStat = fs.statSync(outputPath);
        const inStat = fs.statSync(sourcePath);
        if (outStat.size > 0 && outStat.mtimeMs >= inStat.mtimeMs) return;
      }
    } catch {}

    if (this.pendingTranscodes.has(outputPath)) return;
    this.pendingTranscodes.add(outputPath);

    const ffmpeg = this.getFfmpegBinary();
    const tryRun = (args: string[]) => new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += String(d || ''); });
      proc.on('error', (err) => reject(new Error(err?.message || 'ffmpeg spawn failed')));
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          resolve();
          return;
        }
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        reject(new Error(stderr.slice(0, 800) || `ffmpeg exited ${code}`));
      });
    });

    (async () => {
      const commonOut = ['-movflags', '+faststart', outputPath];
      try {
        await tryRun([
          '-hide_banner', '-loglevel', 'error', '-y',
          '-fflags', '+genpts', '-r', '25', '-f', 'h264', '-i', sourcePath,
          '-c:v', 'copy',
          ...commonOut
        ]);
      } catch {
        await tryRun([
          '-hide_banner', '-loglevel', 'error', '-y',
          '-fflags', '+genpts', '-r', '25', '-f', 'h264', '-i', sourcePath,
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
          ...commonOut
        ]);
      }
    })()
      .catch((err) => {
        console.error(`Failed to transcode ${sourcePath}:`, err?.message || err);
      })
      .finally(() => {
        this.pendingTranscodes.delete(outputPath);
      });
  }

  private buildFinalizedPath(filepath: string): string {
    return filepath.replace(/\.partial(?=\.[^.]+$)/i, '');
  }

  private async validateRecordedSegment(filepath: string): Promise<boolean> {
    try {
      if (!filepath || !fs.existsSync(filepath)) return false;
      const stat = fs.statSync(filepath);
      if (!stat.isFile() || stat.size < this.minValidSegmentBytes) return false;
    } catch {
      return false;
    }

    const isMp4 = /\.mp4$/i.test(filepath);
    const args = isMp4
      ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', filepath, '-frames:v', '1', '-f', 'null', '-']
      : [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-fflags', '+genpts',
          '-r', String(Number(process.env.VIDEO_DEFAULT_INPUT_FPS || 25) || 25),
          '-f', 'h264',
          '-i', filepath,
          '-frames:v', '1',
          '-f', 'null',
          '-'
        ];

    return await new Promise<boolean>((resolve) => {
      const proc = spawn(this.getFfmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve(false);
      }, 12000);
      proc.stderr.on('data', (d) => { stderr += String(d || ''); });
      proc.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code === 0 && !/does not contain any stream/i.test(stderr));
      });
    });
  }

  writeFrame(vehicleId: string, channel: number, frameData: Buffer): void {
    const streamKey = `${vehicleId}_${channel}`;
    
    if (!this.fileStreams.has(streamKey)) {
      this.createOutputStream(vehicleId, channel, streamKey);
    } else {
      const startTime = this.startTimes.get(streamKey);
      if (startTime && Date.now() - startTime.getTime() >= this.segmentDurationMs) {
        this.rotateSegment(vehicleId, channel, streamKey);
      }
    }

    const stream = this.fileStreams.get(streamKey);
    if (stream) {
      stream.write(frameData);
      this.bytesWritten.set(streamKey, (this.bytesWritten.get(streamKey) || 0) + frameData.length);
      
      const frameCount = (this.frameCounters.get(streamKey) || 0) + 1;
      this.frameCounters.set(streamKey, frameCount);
      
      if (frameCount === 1) {
        console.log(`First frame written: vehicle ${vehicleId}, channel ${channel}`);
      }
      
      if (frameCount % 100 === 0) {
        console.log(`Frames written: vehicle ${vehicleId}, channel ${channel}, count ${frameCount}`);
      }

      this.persistProgress(streamKey);
    }
  }

  private async createOutputStream(vehicleId: string, channel: number, streamKey: string): Promise<void> {
    const recordingsDir = path.join(process.cwd(), 'recordings', vehicleId);
    
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    const startedAt = new Date();
    const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const filename = `channel_${channel}_${timestamp}.partial.h264`;
    const filepath = path.join(recordingsDir, filename);
    
    const stream = fs.createWriteStream(filepath);
    this.fileStreams.set(streamKey, stream);
    this.startTimes.set(streamKey, startedAt);
    this.filePaths.set(streamKey, filepath);
    this.bytesWritten.set(streamKey, 0);
    this.lastPersistTimes.set(streamKey, 0);
    
    stream.on('error', (error) => {
      console.error(`Error writing video file ${filepath}:`, error);
      this.fileStreams.delete(streamKey);
    });

    console.log(`Video recording started: ${filepath}`);
    
    // Save to database
    try {
      const videoId = await this.videoStorage.saveVideo(
        vehicleId,
        channel,
        filepath,
        startedAt,
        'live'
      );
      this.videoIds.set(streamKey, videoId);
      await this.videoStorage.updateVideoProgress(videoId, startedAt, 0, 0, 0);
      this.lastPersistTimes.set(streamKey, Date.now());
    } catch (error) {
      console.error('Failed to save video metadata to database:', error);
    }
  }

  private persistProgress(streamKey: string, force = false): void {
    const videoId = this.videoIds.get(streamKey);
    const startTime = this.startTimes.get(streamKey);
    if (!videoId || !startTime) return;

    const now = Date.now();
    const lastPersist = this.lastPersistTimes.get(streamKey) || 0;
    if (!force && now - lastPersist < this.progressUpdateMs) {
      return;
    }

    const duration = Math.max(0, Math.floor((now - startTime.getTime()) / 1000));
    const fileSize = Math.max(0, this.bytesWritten.get(streamKey) || 0);
    const frameCount = Math.max(0, this.frameCounters.get(streamKey) || 0);
    this.lastPersistTimes.set(streamKey, now);
    this.videoStorage
      .updateVideoProgress(videoId, new Date(now), fileSize, duration, frameCount)
      .catch((error) => {
        console.error(`Failed to persist video progress for ${streamKey}:`, error);
      });
  }

  private finalizeSegment(streamKey: string, vehicleId: string, channel: number): void {
    const stream = this.fileStreams.get(streamKey);
    
    if (stream) {
      const videoId = this.videoIds.get(streamKey);
      const startTime = this.startTimes.get(streamKey);
      const filepath = this.filePaths.get(streamKey);
      this.persistProgress(streamKey, true);
      stream.end(() => {
        if (videoId && startTime && filepath) {
          const endTime = new Date();
          const duration = Math.max(1, Math.floor((endTime.getTime() - startTime.getTime()) / 1000));
          try {
            const sizeFromCounter = this.bytesWritten.get(streamKey) || 0;
            const finalizedPath = this.buildFinalizedPath(filepath);
            if (fs.existsSync(filepath) && finalizedPath !== filepath) {
              try {
                fs.renameSync(filepath, finalizedPath);
              } catch (renameError) {
                console.error(`Failed to finalize segment ${filepath}:`, renameError);
              }
            }
            const usablePath = fs.existsSync(finalizedPath) ? finalizedPath : filepath;
            const stats = fs.existsSync(usablePath) ? fs.statSync(usablePath) : null;
            const finalSize = Math.max(sizeFromCounter, stats?.size || 0);
            const frameCount = Math.max(0, this.frameCounters.get(streamKey) || 0);
            this.validateRecordedSegment(usablePath)
              .then((valid) => {
                if (!valid) {
                  try { if (fs.existsSync(usablePath)) fs.unlinkSync(usablePath); } catch {}
                  return this.videoStorage.deleteVideo(videoId);
                }
                this.kickoffPlayableTranscode(usablePath);
                return this.videoStorage.updateVideoEnd(videoId, endTime, finalSize, duration, frameCount, usablePath);
              })
              .catch((err) => {
                console.error(`Failed to finalize validated segment ${usablePath}:`, err);
              });
          } catch (error) {
            console.error('Failed to update video metadata:', error);
          }
        }
      });
      this.fileStreams.delete(streamKey);
      
      const frameCount = this.frameCounters.get(streamKey) || 0;
      console.log(`Video recording stopped: vehicle ${vehicleId}, channel ${channel}, total frames ${frameCount}`);
      this.frameCounters.delete(streamKey);
      this.videoIds.delete(streamKey);
      this.startTimes.delete(streamKey);
      this.filePaths.delete(streamKey);
      this.bytesWritten.delete(streamKey);
      this.lastPersistTimes.delete(streamKey);
    }
  }

  private rotateSegment(vehicleId: string, channel: number, streamKey: string): void {
    this.finalizeSegment(streamKey, vehicleId, channel);
    this.createOutputStream(vehicleId, channel, streamKey);
  }

  private rotateExpiredSegments(): void {
    const now = Date.now();
    for (const streamKey of this.fileStreams.keys()) {
      const startTime = this.startTimes.get(streamKey);
      if (!startTime) continue;
      if (now - startTime.getTime() < this.segmentDurationMs) continue;

      const separator = streamKey.lastIndexOf('_');
      if (separator <= 0) continue;
      const vehicleId = streamKey.slice(0, separator);
      const channel = Number(streamKey.slice(separator + 1));
      if (!vehicleId || !Number.isFinite(channel)) continue;

      this.rotateSegment(vehicleId, channel, streamKey);
    }
  }

  stopRecording(vehicleId: string, channel: number): void {
    const streamKey = `${vehicleId}_${channel}`;
    this.finalizeSegment(streamKey, vehicleId, channel);
  }

  stopAllRecordings(): void {
    clearInterval(this.rotationTimer);
    for (const [streamKey] of this.fileStreams.entries()) {
      const [vehicleId, channelStr] = streamKey.split('_');
      this.finalizeSegment(streamKey, vehicleId, Number(channelStr || 1));
      console.log(`Stopped recording: ${streamKey}`);
    }
    this.fileStreams.clear();
    this.frameCounters.clear();
    this.filePaths.clear();
    VideoWriter.activeInstances.delete(this);
  }

  getRecordingStats(): { activeRecordings: number; totalFrames: number } {
    const totalFrames = Array.from(this.frameCounters.values()).reduce((sum, count) => sum + count, 0);
    return {
      activeRecordings: this.fileStreams.size,
      totalFrames
    };
  }
}
