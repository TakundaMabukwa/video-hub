import * as fs from 'fs';
import * as path from 'path';
import { VideoStorage } from '../storage/videoStorage';

export class VideoWriter {
  private fileStreams = new Map<string, fs.WriteStream>();
  private frameCounters = new Map<string, number>();
  private videoStorage = new VideoStorage();
  private videoIds = new Map<string, string>();
  private startTimes = new Map<string, Date>();
  private filePaths = new Map<string, string>();
  private readonly segmentDurationMs = Math.max(10_000, Number(process.env.LIVE_SEGMENT_SECONDS || 60) * 1000);

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
      
      const frameCount = (this.frameCounters.get(streamKey) || 0) + 1;
      this.frameCounters.set(streamKey, frameCount);
      
      if (frameCount === 1) {
        console.log(`First frame written: vehicle ${vehicleId}, channel ${channel}`);
      }
      
      if (frameCount % 100 === 0) {
        console.log(`Frames written: vehicle ${vehicleId}, channel ${channel}, count ${frameCount}`);
      }
    }
  }

  private async createOutputStream(vehicleId: string, channel: number, streamKey: string): Promise<void> {
    const recordingsDir = path.join(process.cwd(), 'recordings', vehicleId);
    
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    const startedAt = new Date();
    const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const filename = `channel_${channel}_${timestamp}.h264`;
    const filepath = path.join(recordingsDir, filename);
    
    const stream = fs.createWriteStream(filepath);
    this.fileStreams.set(streamKey, stream);
    this.startTimes.set(streamKey, startedAt);
    this.filePaths.set(streamKey, filepath);
    
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
    } catch (error) {
      console.error('Failed to save video metadata to database:', error);
    }
  }

  private finalizeSegment(streamKey: string, vehicleId: string, channel: number): void {
    const stream = this.fileStreams.get(streamKey);
    
    if (stream) {
      const videoId = this.videoIds.get(streamKey);
      const startTime = this.startTimes.get(streamKey);
      const filepath = this.filePaths.get(streamKey);
      stream.end(() => {
        if (videoId && startTime && filepath) {
          const endTime = new Date();
          const duration = Math.max(1, Math.floor((endTime.getTime() - startTime.getTime()) / 1000));
          try {
            const stats = fs.statSync(filepath);
            this.videoStorage.updateVideoEnd(videoId, endTime, stats.size, duration).catch(console.error);
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
    }
  }

  private rotateSegment(vehicleId: string, channel: number, streamKey: string): void {
    this.finalizeSegment(streamKey, vehicleId, channel);
    this.createOutputStream(vehicleId, channel, streamKey);
  }

  stopRecording(vehicleId: string, channel: number): void {
    const streamKey = `${vehicleId}_${channel}`;
    this.finalizeSegment(streamKey, vehicleId, channel);
  }

  stopAllRecordings(): void {
    for (const [streamKey] of this.fileStreams.entries()) {
      const [vehicleId, channelStr] = streamKey.split('_');
      this.finalizeSegment(streamKey, vehicleId, Number(channelStr || 1));
      console.log(`Stopped recording: ${streamKey}`);
    }
    this.fileStreams.clear();
    this.frameCounters.clear();
    this.filePaths.clear();
  }

  getRecordingStats(): { activeRecordings: number; totalFrames: number } {
    const totalFrames = Array.from(this.frameCounters.values()).reduce((sum, count) => sum + count, 0);
    return {
      activeRecordings: this.fileStreams.size,
      totalFrames
    };
  }
}
