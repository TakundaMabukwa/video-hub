import * as fs from 'fs';
import * as path from 'path';
import { LiveVideoStreamServer } from './liveStream';

export type ReplayFile = {
  filePath: string;
  startTime?: Date;
  endTime?: Date | null;
  durationSec?: number | null;
};

type ReplayOptions = {
  vehicleId: string;
  channel: number;
  startTime: Date;
  endTime: Date;
  speed?: number;
  fps?: number;
};

type ReplayState = {
  id: string;
  vehicleId: string;
  channel: number;
  startedAt: string;
  stop: boolean;
};

export class ReplayService {
  private broadcaster: LiveVideoStreamServer;
  private active = new Map<string, ReplayState>();

  constructor(broadcaster: LiveVideoStreamServer) {
    this.broadcaster = broadcaster;
  }

  public startReplay(opts: ReplayOptions, files: ReplayFile[]): string {
    const id = `REPLAY-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const state: ReplayState = {
      id,
      vehicleId: opts.vehicleId,
      channel: opts.channel,
      startedAt: new Date().toISOString(),
      stop: false
    };
    this.active.set(id, state);

    void this.runReplay(id, opts, files).finally(() => {
      this.active.delete(id);
    });

    return id;
  }

  public stopReplay(id: string): boolean {
    const state = this.active.get(id);
    if (!state) return false;
    state.stop = true;
    return true;
  }

  public listReplays() {
    return Array.from(this.active.values());
  }

  private async runReplay(id: string, opts: ReplayOptions, files: ReplayFile[]): Promise<void> {
    const fps = Math.max(1, Math.min(30, Number(opts.fps || 15)));
    const speed = Math.max(0.25, Math.min(4, Number(opts.speed || 1)));
    const intervalMs = 1000 / (fps * speed);

    for (const file of files) {
      const state = this.active.get(id);
      if (!state || state.stop) return;

      const localPath = path.isAbsolute(file.filePath)
        ? file.filePath
        : path.join(process.cwd(), file.filePath);
      if (!fs.existsSync(localPath)) continue;

      const fileStart = file.startTime ? new Date(file.startTime) : null;
      const fileEnd = file.endTime ? new Date(file.endTime) : null;
      const durationSec = Number(file.durationSec || 0) || (
        fileStart && fileEnd ? Math.max(1, (fileEnd.getTime() - fileStart.getTime()) / 1000) : 0
      );

      let skipFrames = 0;
      let maxFrames = 0;
      if (fileStart && durationSec > 0) {
        const fileStartMs = fileStart.getTime();
        const fileEndMs = fileEnd ? fileEnd.getTime() : (fileStartMs + durationSec * 1000);
        const effectiveStart = Math.max(opts.startTime.getTime(), fileStartMs);
        const effectiveEnd = Math.min(opts.endTime.getTime(), fileEndMs);
        const playMs = Math.max(0, effectiveEnd - effectiveStart);
        const skipMs = Math.max(0, effectiveStart - fileStartMs);
        if (playMs <= 0) {
          continue;
        }
        skipFrames = Math.floor((skipMs / 1000) * fps);
        maxFrames = Math.ceil((playMs / 1000) * fps);
      }

      let sentFrames = 0;
      await this.streamH264File(localPath, opts.vehicleId, opts.channel, intervalMs, () => {
        const stateNow = this.active.get(id);
        if (!stateNow || stateNow.stop) return { stop: true };
        if (maxFrames > 0 && sentFrames >= maxFrames) return { stop: true };
        return { stop: false, skipFrames };
      }, (didSendFrame) => {
        if (didSendFrame) {
          if (skipFrames > 0) skipFrames -= 1;
          else sentFrames += 1;
        }
      });
    }
  }

  private async streamH264File(
    filePath: string,
    vehicleId: string,
    channel: number,
    intervalMs: number,
    shouldStop: () => { stop: boolean; skipFrames?: number },
    onFrameProgress: (sent: boolean) => void
  ): Promise<void> {
    const stream = fs.createReadStream(filePath);
    let buffer = Buffer.alloc(0);
    let lastStart = -1;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const emitNal = async (nal: Buffer) => {
      const state = shouldStop();
      if (state.stop) return false;

      if (nal.length < 5) return true;
      const startCodeLen = (nal[2] === 0x01) ? 3 : 4;
      if (nal.length <= startCodeLen) return true;

      const nalType = nal[startCodeLen] & 0x1f;
      const isFrameNal = nalType === 1 || nalType === 5;
      const shouldSkip = isFrameNal && (state.skipFrames || 0) > 0;

      if (!shouldSkip) {
        this.broadcaster.broadcastFrame(vehicleId, channel, nal, nalType === 5, 'replay');
      }
      onFrameProgress(isFrameNal);
      if (isFrameNal && !shouldSkip) {
        await sleep(intervalMs);
      }
      return true;
    };

    for await (const chunk of stream) {
      const state = shouldStop();
      if (state.stop) break;

      buffer = Buffer.concat([buffer, chunk]);
      const len = buffer.length;
      const starts: number[] = [];

      for (let i = 0; i < len - 3; i++) {
        if (i + 3 < len && buffer[i] === 0x00 && buffer[i + 1] === 0x00 &&
            buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
          starts.push(i);
          i += 3;
          continue;
        }
        if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 && buffer[i + 2] === 0x01) {
          starts.push(i);
          i += 2;
        }
      }

      for (const start of starts) {
        if (lastStart >= 0 && start > lastStart) {
          const nal = buffer.slice(lastStart, start);
          const ok = await emitNal(nal);
          if (!ok) return;
        }
        lastStart = start;
      }

      if (lastStart > 0) {
        buffer = buffer.slice(lastStart);
        lastStart = 0;
      } else if (buffer.length > 2 * 1024 * 1024) {
        buffer = Buffer.alloc(0);
        lastStart = -1;
      }
    }

    if (lastStart >= 0 && buffer.length > 0) {
      await emitNal(buffer);
    }
  }
}
