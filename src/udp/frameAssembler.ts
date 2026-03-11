import { JTT1078RTPHeader, JTT1078SubpackageFlag } from '../types/jtt';

interface FrameBuffer {
  timestamp: string;
  channelNumber: number;
  parts: Buffer[];
  expectedSequence: number;
  startTime: number;
  dataType: number;
}

export class FrameAssembler {
  private frameBuffers = new Map<string, FrameBuffer>();
  private readonly FRAME_TIMEOUT = 3000; // Reduced from 5s
  private readonly MAX_BUFFERS = 50; // Reduced from 500
  private readonly CLEANUP_INTERVAL = 5000; // Cleanup every 5s
  private lastCleanup = Date.now();
  private spsCache = new Map<string, Buffer>();
  private ppsCache = new Map<string, Buffer>();

  assembleFrame(header: JTT1078RTPHeader, payload: Buffer, dataType: number): Buffer | null {
    // Aggressive cleanup
    if (Date.now() - this.lastCleanup > this.CLEANUP_INTERVAL) {
      this.cleanupOldFrames();
      this.lastCleanup = Date.now();
    }

    // Hard limit on buffers
    if (this.frameBuffers.size >= this.MAX_BUFFERS) {
      const keysToDelete = Array.from(this.frameBuffers.keys()).slice(0, 10);
      keysToDelete.forEach(k => this.frameBuffers.delete(k));
      console.warn(`⚠️ Buffer limit reached, cleared ${keysToDelete.length} old frames`);
    }
    
    // Use only simCard + channel as key (timestamp changes per packet!)
    const key = `${header.simCard}_${header.channelNumber}`;
    
    console.log(`📦 RTP: ${header.simCard}_ch${header.channelNumber}, seq=${header.sequenceNumber}, flag=${header.subpackageFlag}, size=${payload.length}`);

    this.extractParameterSets(payload, key);

    if (header.subpackageFlag === JTT1078SubpackageFlag.ATOMIC) {
      console.log(`   ✅ ATOMIC - complete frame`);
      return this.prependParameterSets(payload, key);
    }

    if (header.subpackageFlag === JTT1078SubpackageFlag.FIRST) {
      console.log(`   🆕 FIRST - new frame`);
      this.frameBuffers.set(key, {
        timestamp: header.timestamp?.toString() || Date.now().toString(),
        channelNumber: header.channelNumber,
        parts: [payload],
        expectedSequence: header.sequenceNumber + 1,
        startTime: Date.now(),
        dataType
      });
      return null;
    }

    const frameBuffer = this.frameBuffers.get(key);
    if (!frameBuffer) {
      console.log(`   ⚠️ No FIRST packet - ignoring`);
      return null;
    }

    // Accept MIDDLE/LAST packets (don't enforce strict sequence)
    frameBuffer.parts.push(payload);
    console.log(`   🔗 Added part ${frameBuffer.parts.length}`);

    if (header.subpackageFlag === JTT1078SubpackageFlag.LAST) {
      console.log(`   ✅ LAST - assembling ${frameBuffer.parts.length} parts`);
      const completeFrame = Buffer.concat(frameBuffer.parts);
      this.frameBuffers.delete(key);
      return this.prependParameterSets(completeFrame, key);
    }

    return null;
  }

  private extractParameterSets(payload: Buffer, streamKey: string): void {
    for (let i = 0; i < payload.length - 4; i++) {
      if (payload[i] === 0x00 && payload[i + 1] === 0x00 && 
          payload[i + 2] === 0x00 && payload[i + 3] === 0x01) {
        const nalType = payload[i + 4] & 0x1F;
        
        // Find next start code
        let nextStart = payload.length;
        for (let j = i + 4; j < payload.length - 4; j++) {
          if (payload[j] === 0x00 && payload[j + 1] === 0x00 && 
              payload[j + 2] === 0x00 && payload[j + 3] === 0x01) {
            nextStart = j;
            break;
          }
        }
        
        if (nalType === 7) { // SPS
          this.spsCache.set(streamKey, payload.slice(i, nextStart));
        } else if (nalType === 8) { // PPS
          this.ppsCache.set(streamKey, payload.slice(i, nextStart));
        }
        
        i = nextStart - 1;
      }
    }
  }

  private prependParameterSets(frame: Buffer, streamKey: string): Buffer {
    const sps = this.spsCache.get(streamKey);
    const pps = this.ppsCache.get(streamKey);
    
    // Only prepend if this is an I-frame and we have SPS/PPS
    if (sps && pps && this.isIFrame(frame)) {
      return Buffer.concat([sps, pps, frame]);
    }
    
    return frame;
  }

  private isIFrame(frame: Buffer): boolean {
    for (let i = 0; i < frame.length - 4; i++) {
      if (frame[i] === 0x00 && frame[i + 1] === 0x00 && 
          frame[i + 2] === 0x00 && frame[i + 3] === 0x01) {
        const nalType = frame[i + 4] & 0x1F;
        if (nalType === 5) return true;
      }
    }
    return false;
  }

  private cleanupOldFrames(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, frameBuffer] of this.frameBuffers.entries()) {
      if (now - frameBuffer.startTime > this.FRAME_TIMEOUT) {
        this.frameBuffers.delete(key);
        cleaned++;
      }
    }
    
    // Also limit SPS/PPS cache
    if (this.spsCache.size > 20) {
      const keys = Array.from(this.spsCache.keys()).slice(0, 10);
      keys.forEach(k => this.spsCache.delete(k));
    }
    if (this.ppsCache.size > 20) {
      const keys = Array.from(this.ppsCache.keys()).slice(0, 10);
      keys.forEach(k => this.ppsCache.delete(k));
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} stale frames`);
    }
  }

  getStats(): { activeFrames: number; totalBuffers: number } {
    return {
      activeFrames: this.frameBuffers.size,
      totalBuffers: Array.from(this.frameBuffers.values()).reduce((sum, frame) => sum + frame.parts.length, 0)
    };
  }
}
