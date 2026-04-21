import { JTT1078RTPHeader, JTT1078SubpackageFlag } from '../types/jtt';

interface FrameBuffer {
  frameKey: string;
  timestamp: string;
  channelNumber: number;
  dataType: number;
  firstSequence?: number;
  lastSequence?: number;
  seenFirst: boolean;
  seenLast: boolean;
  packets: Map<number, Buffer>;
  startTime: number;
  lastUpdatedAt: number;
}

interface FrameAssemblerStats {
  activeStreams: number;
  activeFrames: number;
  totalPacketsBuffered: number;
  completedFrames: number;
  droppedFrames: number;
  timedOutFrames: number;
  evictedFrames: number;
  recoveredOutOfOrderFrames: number;
  orphanPacketsBuffered: number;
  ignoredPackets: number;
}

export class FrameAssembler {
  private frameBuffers = new Map<string, Map<string, FrameBuffer>>();
  private readonly FRAME_TIMEOUT = Math.max(1000, Number(process.env.FRAME_ASSEMBLER_TIMEOUT_MS || 10000));
  private readonly MAX_STREAMS = Math.max(50, Number(process.env.FRAME_ASSEMBLER_MAX_STREAMS || 200));
  private readonly MAX_FRAMES_PER_STREAM = Math.max(4, Number(process.env.FRAME_ASSEMBLER_MAX_FRAMES_PER_STREAM || 16));
  private readonly MAX_TOTAL_FRAMES = Math.max(100, Number(process.env.FRAME_ASSEMBLER_MAX_TOTAL_FRAMES || 1000));
  private readonly CLEANUP_INTERVAL = Math.max(1000, Number(process.env.FRAME_ASSEMBLER_CLEANUP_INTERVAL_MS || 3000));
  private lastCleanup = Date.now();
  private spsCache = new Map<string, Buffer>();
  private ppsCache = new Map<string, Buffer>();
  private stats = {
    completedFrames: 0,
    droppedFrames: 0,
    timedOutFrames: 0,
    evictedFrames: 0,
    recoveredOutOfOrderFrames: 0,
    orphanPacketsBuffered: 0,
    ignoredPackets: 0
  };

  assembleFrame(header: JTT1078RTPHeader, payload: Buffer, dataType: number): Buffer | null {
    const now = Date.now();

    if (now - this.lastCleanup > this.CLEANUP_INTERVAL) {
      this.cleanupOldFrames(now);
      this.lastCleanup = now;
    }

    const streamKey = `${header.simCard}_${header.channelNumber}`;
    const normalized = this.normalizeAnnexB(payload);
    this.extractParameterSets(normalized, streamKey);

    if (header.subpackageFlag === JTT1078SubpackageFlag.ATOMIC) {
      this.stats.completedFrames += 1;
      return this.prependParameterSets(normalized, streamKey);
    }

    const streamFrames = this.getOrCreateStreamFrames(streamKey);
    const frameKey = this.buildFrameKey(header);
    let frameBuffer = streamFrames.get(frameKey);

    if (!frameBuffer) {
      frameBuffer = this.findCandidateFrameBuffer(streamFrames, header, dataType, now);
    }

    if (!frameBuffer) {
      frameBuffer = this.createFrameBuffer(header, dataType, frameKey, now);
      streamFrames.set(frameKey, frameBuffer);

      if (header.subpackageFlag !== JTT1078SubpackageFlag.FIRST) {
        this.stats.orphanPacketsBuffered += 1;
      }
    }

    this.trimStreamFrames(streamFrames, now);
    this.trimGlobalFrames(now);

    const hadPacketsBeforeFirst = !frameBuffer.seenFirst && frameBuffer.packets.size > 0;
    frameBuffer.lastUpdatedAt = now;
    frameBuffer.dataType = dataType;

    if (header.subpackageFlag === JTT1078SubpackageFlag.FIRST) {
      frameBuffer.seenFirst = true;
      frameBuffer.firstSequence = header.sequenceNumber;
      if (hadPacketsBeforeFirst) {
        this.stats.recoveredOutOfOrderFrames += 1;
      }
    }

    frameBuffer.packets.set(header.sequenceNumber, normalized);

    if (header.subpackageFlag === JTT1078SubpackageFlag.LAST) {
      frameBuffer.seenLast = true;
      frameBuffer.lastSequence = header.sequenceNumber;
    }

    const completeFrame = this.tryAssembleFrame(streamKey, streamFrames, frameBuffer);
    if (completeFrame) {
      this.stats.completedFrames += 1;
      return completeFrame;
    }

    return null;
  }

  private buildFrameKey(header: JTT1078RTPHeader): string {
    if (header.timestamp !== undefined) {
      return `${header.timestamp.toString()}_${header.dataType}`;
    }

    return `seq_${header.sequenceNumber}_${Date.now()}`;
  }

  private getOrCreateStreamFrames(streamKey: string): Map<string, FrameBuffer> {
    let streamFrames = this.frameBuffers.get(streamKey);
    if (!streamFrames) {
      if (this.frameBuffers.size >= this.MAX_STREAMS) {
        const oldestStreamKey = this.frameBuffers.keys().next().value;
        if (oldestStreamKey) {
          this.dropStream(oldestStreamKey, 'evicted');
        }
      }

      streamFrames = new Map<string, FrameBuffer>();
      this.frameBuffers.set(streamKey, streamFrames);
    }

    return streamFrames;
  }

  private createFrameBuffer(
    header: JTT1078RTPHeader,
    dataType: number,
    frameKey: string,
    now: number
  ): FrameBuffer {
    return {
      frameKey,
      timestamp: header.timestamp?.toString() || now.toString(),
      channelNumber: header.channelNumber,
      dataType,
      firstSequence: undefined,
      lastSequence: undefined,
      seenFirst: false,
      seenLast: false,
      packets: new Map<number, Buffer>(),
      startTime: now,
      lastUpdatedAt: now
    };
  }

  private findCandidateFrameBuffer(
    streamFrames: Map<string, FrameBuffer>,
    header: JTT1078RTPHeader,
    dataType: number,
    now: number
  ): FrameBuffer | undefined {
    let bestCandidate: FrameBuffer | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of streamFrames.values()) {
      if (candidate.dataType !== dataType) continue;
      if (candidate.seenLast) continue;
      if (now - candidate.lastUpdatedAt > this.FRAME_TIMEOUT) continue;

      let score = now - candidate.lastUpdatedAt;

      if (!candidate.seenFirst) {
        if (header.subpackageFlag === JTT1078SubpackageFlag.FIRST) {
          score -= 1000;
        } else {
          score -= 500;
        }
      }

      if (candidate.firstSequence !== undefined) {
        const sequenceGap = this.sequenceDistance(candidate.firstSequence, header.sequenceNumber);
        if (sequenceGap > 4096) continue;
        score += sequenceGap;
      }

      if (candidate.timestamp === (header.timestamp?.toString() || '')) {
        score -= 2000;
      }

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    return bestCandidate;
  }

  private tryAssembleFrame(
    streamKey: string,
    streamFrames: Map<string, FrameBuffer>,
    frameBuffer: FrameBuffer
  ): Buffer | null {
    if (!frameBuffer.seenFirst || !frameBuffer.seenLast) {
      return null;
    }

    if (frameBuffer.firstSequence === undefined || frameBuffer.lastSequence === undefined) {
      return null;
    }

    const orderedSequences = Array.from(frameBuffer.packets.keys()).sort((a, b) =>
      this.sequenceCompare(a, b, frameBuffer.firstSequence!)
    );

    const expectedPackets =
      this.sequenceDistance(frameBuffer.firstSequence, frameBuffer.lastSequence) + 1;

    if (orderedSequences.length !== expectedPackets) {
      return null;
    }

    for (let index = 0; index < orderedSequences.length; index += 1) {
      const expectedSequence = this.addSequence(frameBuffer.firstSequence, index);
      if (orderedSequences[index] !== expectedSequence) {
        return null;
      }
    }

    const parts = orderedSequences
      .map((sequence) => frameBuffer.packets.get(sequence))
      .filter((part): part is Buffer => Boolean(part));

    streamFrames.delete(frameBuffer.frameKey);
    if (streamFrames.size === 0) {
      this.frameBuffers.delete(streamKey);
    }

    const completeFrame = Buffer.concat(parts);
    return this.prependParameterSets(this.normalizeAnnexB(completeFrame), streamKey);
  }

  private trimStreamFrames(streamFrames: Map<string, FrameBuffer>, now: number): void {
    while (streamFrames.size > this.MAX_FRAMES_PER_STREAM) {
      const oldest = this.findOldestFrame(streamFrames);
      if (!oldest) {
        break;
      }
      streamFrames.delete(oldest.frameKey);
      this.recordDrop(oldest, 'evicted');
    }

    for (const [frameKey, frameBuffer] of streamFrames.entries()) {
      if (now - frameBuffer.lastUpdatedAt > this.FRAME_TIMEOUT) {
        streamFrames.delete(frameKey);
        this.recordDrop(frameBuffer, 'timeout');
      }
    }
  }

  private trimGlobalFrames(now: number): void {
    while (this.getTotalFrameCount() > this.MAX_TOTAL_FRAMES) {
      let oldestStreamKey: string | null = null;
      let oldestFrame: FrameBuffer | null = null;

      for (const [streamKey, streamFrames] of this.frameBuffers.entries()) {
        const candidate = this.findOldestFrame(streamFrames);
        if (!candidate) continue;
        if (!oldestFrame || candidate.lastUpdatedAt < oldestFrame.lastUpdatedAt) {
          oldestStreamKey = streamKey;
          oldestFrame = candidate;
        }
      }

      if (!oldestStreamKey || !oldestFrame) {
        break;
      }

      const streamFrames = this.frameBuffers.get(oldestStreamKey);
      streamFrames?.delete(oldestFrame.frameKey);
      if (streamFrames && streamFrames.size === 0) {
        this.frameBuffers.delete(oldestStreamKey);
      }
      this.recordDrop(oldestFrame, 'evicted');
    }

    this.cleanupOldFrames(now);
  }

  private cleanupOldFrames(now: number): void {
    for (const [streamKey, streamFrames] of this.frameBuffers.entries()) {
      for (const [frameKey, frameBuffer] of streamFrames.entries()) {
        if (now - frameBuffer.lastUpdatedAt > this.FRAME_TIMEOUT) {
          streamFrames.delete(frameKey);
          this.recordDrop(frameBuffer, 'timeout');
        }
      }

      if (streamFrames.size === 0) {
        this.frameBuffers.delete(streamKey);
      }
    }

    this.trimCache(this.spsCache, 100);
    this.trimCache(this.ppsCache, 100);
  }

  private dropStream(streamKey: string, reason: 'timeout' | 'evicted'): void {
    const streamFrames = this.frameBuffers.get(streamKey);
    if (!streamFrames) return;

    for (const frameBuffer of streamFrames.values()) {
      this.recordDrop(frameBuffer, reason);
    }

    this.frameBuffers.delete(streamKey);
  }

  private recordDrop(_frameBuffer: FrameBuffer, reason: 'timeout' | 'evicted'): void {
    this.stats.droppedFrames += 1;
    if (reason === 'timeout') {
      this.stats.timedOutFrames += 1;
    } else {
      this.stats.evictedFrames += 1;
    }
  }

  private findOldestFrame(streamFrames: Map<string, FrameBuffer>): FrameBuffer | null {
    let oldest: FrameBuffer | null = null;
    for (const frameBuffer of streamFrames.values()) {
      if (!oldest || frameBuffer.lastUpdatedAt < oldest.lastUpdatedAt) {
        oldest = frameBuffer;
      }
    }
    return oldest;
  }

  private getTotalFrameCount(): number {
    let total = 0;
    for (const streamFrames of this.frameBuffers.values()) {
      total += streamFrames.size;
    }
    return total;
  }

  private sequenceDistance(start: number, end: number): number {
    return (end - start + 65536) % 65536;
  }

  private addSequence(base: number, offset: number): number {
    return (base + offset) % 65536;
  }

  private sequenceCompare(a: number, b: number, base: number): number {
    const distanceA = this.sequenceDistance(base, a);
    const distanceB = this.sequenceDistance(base, b);
    return distanceA - distanceB;
  }

  private trimCache(cache: Map<string, Buffer>, maxSize: number): void {
    while (cache.size > maxSize) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  }

  private normalizeAnnexB(payload: Buffer): Buffer {
    if (!payload || payload.length < 4) return payload;

    for (let i = 0; i < payload.length - 3; i += 1) {
      if (
        payload[i] === 0x00 &&
        payload[i + 1] === 0x00 &&
        (payload[i + 2] === 0x01 || (payload[i + 2] === 0x00 && payload[i + 3] === 0x01))
      ) {
        return payload;
      }
    }

    const out: Buffer[] = [];
    let offset = 0;
    while (offset + 4 <= payload.length) {
      const nalLen = payload.readUInt32BE(offset);
      offset += 4;
      if (nalLen <= 0 || offset + nalLen > payload.length) {
        return payload;
      }
      const nal = payload.slice(offset, offset + nalLen);
      out.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
      out.push(nal);
      offset += nalLen;
    }
    return out.length ? Buffer.concat(out) : payload;
  }

  private extractParameterSets(payload: Buffer, streamKey: string): void {
    const len = payload.length;
    for (let i = 0; i < len - 3; i += 1) {
      let startCodeLen = 0;
      if (payload[i] === 0x00 && payload[i + 1] === 0x00 && payload[i + 2] === 0x01) {
        startCodeLen = 3;
      } else if (
        i + 3 < len &&
        payload[i] === 0x00 &&
        payload[i + 1] === 0x00 &&
        payload[i + 2] === 0x00 &&
        payload[i + 3] === 0x01
      ) {
        startCodeLen = 4;
      }
      if (!startCodeLen) continue;

      const nalType = payload[i + startCodeLen] & 0x1f;
      let nextStart = len;
      for (let j = i + startCodeLen; j < len - 3; j += 1) {
        if (
          payload[j] === 0x00 &&
          payload[j + 1] === 0x00 &&
          (payload[j + 2] === 0x01 || (payload[j + 2] === 0x00 && payload[j + 3] === 0x01))
        ) {
          nextStart = j;
          break;
        }
      }

      if (nalType === 7) {
        this.spsCache.set(streamKey, payload.slice(i, nextStart));
      } else if (nalType === 8) {
        this.ppsCache.set(streamKey, payload.slice(i, nextStart));
      }

      i = nextStart - 1;
    }
  }

  private prependParameterSets(frame: Buffer, streamKey: string): Buffer {
    const sps = this.spsCache.get(streamKey);
    const pps = this.ppsCache.get(streamKey);

    if (sps && pps && this.isIFrame(frame)) {
      return Buffer.concat([sps, pps, frame]);
    }

    return frame;
  }

  private isIFrame(frame: Buffer): boolean {
    const len = frame.length;
    for (let i = 0; i < len - 3; i += 1) {
      let startCodeLen = 0;
      if (frame[i] === 0x00 && frame[i + 1] === 0x00 && frame[i + 2] === 0x01) {
        startCodeLen = 3;
      } else if (
        i + 3 < len &&
        frame[i] === 0x00 &&
        frame[i + 1] === 0x00 &&
        frame[i + 2] === 0x00 &&
        frame[i + 3] === 0x01
      ) {
        startCodeLen = 4;
      }
      if (!startCodeLen) continue;
      const nalType = frame[i + startCodeLen] & 0x1f;
      if (nalType === 5) return true;
    }
    return false;
  }

  getStats(): FrameAssemblerStats {
    let activeFrames = 0;
    let totalPacketsBuffered = 0;

    for (const streamFrames of this.frameBuffers.values()) {
      activeFrames += streamFrames.size;
      for (const frameBuffer of streamFrames.values()) {
        totalPacketsBuffered += frameBuffer.packets.size;
      }
    }

    return {
      activeStreams: this.frameBuffers.size,
      activeFrames,
      totalPacketsBuffered,
      completedFrames: this.stats.completedFrames,
      droppedFrames: this.stats.droppedFrames,
      timedOutFrames: this.stats.timedOutFrames,
      evictedFrames: this.stats.evictedFrames,
      recoveredOutOfOrderFrames: this.stats.recoveredOutOfOrderFrames,
      orphanPacketsBuffered: this.stats.orphanPacketsBuffered,
      ignoredPackets: this.stats.ignoredPackets
    };
  }
}
