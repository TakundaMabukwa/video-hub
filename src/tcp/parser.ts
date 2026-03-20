import { JTT808Message, JTT808MessageType } from '../types/jtt';

export class JTT808Parser {
  private static lastChecksumWarnAt = 0;
  private static lastParseErrorWarnAt = 0;
  private static readonly LOG_THROTTLE_MS = Math.max(1000, Number(process.env.JT808_PARSE_LOG_THROTTLE_MS || 5000));

  // JT/T 808 message structure: 0x7E + Header + Body + Checksum + 0x7E
  static parseMessage(buffer: Buffer): JTT808Message | null {
    if (buffer.length < 12 || buffer[0] !== 0x7E || buffer[buffer.length - 1] !== 0x7E) {
      return null;
    }

    try {
      // Unescape 0x7D sequences
      const unescaped = this.unescape(buffer.slice(1, -1));
      if (unescaped.length < 12) return null;
      
      const messageId = unescaped.readUInt16BE(0);
      const bodyProps = unescaped.readUInt16BE(2);
      const bodyLength = bodyProps & 0x3FF; // Lower 10 bits
      const isSubpackage = (bodyProps & 0x2000) !== 0;
      const versionFlag = (bodyProps & 0x4000) !== 0;

      let protocolVersion: number | undefined;
      let phoneOffset = 4;
      let phoneLength = 6;
      let serialOffset = 10;
      let headerLength = 12;

      if (versionFlag) {
        if (unescaped.length < 17) return null;
        protocolVersion = unescaped.readUInt8(4);
        phoneOffset = 5;
        phoneLength = 10;
        serialOffset = 15;
        headerLength = 17;
      }

      const phoneBytes = unescaped.slice(phoneOffset, phoneOffset + phoneLength);
      const terminalPhone = this.bcdToString(phoneBytes);
      const serialNumber = unescaped.readUInt16BE(serialOffset);
      let packetCount: number | undefined;
      let packetIndex: number | undefined;

      if (isSubpackage) {
        if (unescaped.length < headerLength + 4) return null;
        packetCount = unescaped.readUInt16BE(headerLength);
        packetIndex = unescaped.readUInt16BE(headerLength + 2);
        headerLength += 4;
      }

      const expectedMinLength = headerLength + bodyLength + 1; // + checksum
      if (unescaped.length < expectedMinLength) {
        return null;
      }

      const body = unescaped.slice(headerLength, headerLength + bodyLength);
      const checksum = unescaped[headerLength + bodyLength];
      
      // Verify checksum
      const calculatedChecksum = this.calculateChecksum(unescaped.slice(0, headerLength + bodyLength));
      if (checksum !== calculatedChecksum) {
        const now = Date.now();
        if (now - this.lastChecksumWarnAt > this.LOG_THROTTLE_MS) {
          this.lastChecksumWarnAt = now;
          console.warn(`JT/T 808 checksum mismatch for msg 0x${messageId.toString(16).padStart(4, '0')} from ${terminalPhone}`);
        }
        return null;
      }

      return {
        messageId,
        bodyLength,
        terminalPhone,
        serialNumber,
        protocolVersion,
        versionFlag,
        isSubpackage,
        packetCount,
        packetIndex,
        body,
        checksum
      };
    } catch (error) {
      const now = Date.now();
      if (now - this.lastParseErrorWarnAt > this.LOG_THROTTLE_MS) {
        this.lastParseErrorWarnAt = now;
        console.error('Failed to parse JT/T 808 message:', error);
      }
      return null;
    }
  }

  static buildResponse(messageId: number, terminalPhone: string, serialNumber: number, body: Buffer = Buffer.alloc(0)): Buffer {
    const phoneBytes = this.stringToBcd(terminalPhone);
    const bodyLength = body.length;
    
    // Build message without escape sequences
    const message = Buffer.alloc(13 + bodyLength);
    message.writeUInt16BE(messageId, 0);
    message.writeUInt16BE(bodyLength, 2);
    phoneBytes.copy(message, 4);
    message.writeUInt16BE(serialNumber, 10);
    body.copy(message, 12);
    
    const checksum = this.calculateChecksum(message);
    message[12 + bodyLength] = checksum;
    
    // Escape and add frame delimiters
    const escaped = this.escape(message);
    const result = Buffer.alloc(escaped.length + 2);
    result[0] = 0x7E;
    escaped.copy(result, 1);
    result[result.length - 1] = 0x7E;
    
    return result;
  }

  private static unescape(buffer: Buffer): Buffer {
    const result: number[] = [];
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x7D && i + 1 < buffer.length) {
        if (buffer[i + 1] === 0x01) {
          result.push(0x7D);
          i++;
        } else if (buffer[i + 1] === 0x02) {
          result.push(0x7E);
          i++;
        } else {
          result.push(buffer[i]);
        }
      } else {
        result.push(buffer[i]);
      }
    }
    return Buffer.from(result);
  }

  private static escape(buffer: Buffer): Buffer {
    const result: number[] = [];
    for (const byte of buffer) {
      if (byte === 0x7E) {
        result.push(0x7D, 0x02);
      } else if (byte === 0x7D) {
        result.push(0x7D, 0x01);
      } else {
        result.push(byte);
      }
    }
    return Buffer.from(result);
  }

  private static calculateChecksum(buffer: Buffer): number {
    let checksum = 0;
    for (const byte of buffer) {
      checksum ^= byte;
    }
    return checksum;
  }

  private static bcdToString(buffer: Buffer): string {
    return buffer.toString('hex');
  }

  private static stringToBcd(str: string): Buffer {
    const padded = str.padStart(12, '0');
    return Buffer.from(padded, 'hex');
  }
}
