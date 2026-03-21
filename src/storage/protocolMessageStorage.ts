import { isDatabaseEnabled, query } from './database';

export type StoredProtocolMessage = {
  id?: number;
  receivedAt: string;
  direction?: 'inbound' | 'outbound';
  vehicleId: string;
  messageId?: number | null;
  messageIdHex?: string | null;
  serialNumber: number;
  bodyLength: number;
  isSubpackage: boolean;
  packetCount?: number;
  packetIndex?: number;
  rawFrameHex: string;
  bodyHex: string;
  bodyTextPreview: string;
  parseSuccess?: boolean | null;
  parseError?: string | null;
  parse?: Record<string, unknown>;
};

type ListProtocolMessagesOptions = {
  vehicleId?: string;
  messageId?: number;
  direction?: 'inbound' | 'outbound';
  limit?: number;
  offset?: number;
};

export class ProtocolMessageStorage {
  private readonly dbEnabled = isDatabaseEnabled();

  async save(entry: StoredProtocolMessage): Promise<void> {
    if (!this.dbEnabled) return;

    await query(
      `INSERT INTO protocol_messages (
        received_at,
        direction,
        vehicle_id,
        message_id,
        message_id_hex,
        serial_number,
        body_length,
        is_subpackage,
        packet_count,
        packet_index,
        raw_frame_hex,
        body_hex,
        body_text_preview,
        parse_success,
        parse_error,
        parse
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb
      )`,
      [
        entry.receivedAt,
        entry.direction || 'inbound',
        entry.vehicleId || '',
        entry.messageId ?? null,
        entry.messageIdHex || null,
        Number(entry.serialNumber || 0),
        Number(entry.bodyLength || 0),
        !!entry.isSubpackage,
        entry.packetCount ?? null,
        entry.packetIndex ?? null,
        entry.rawFrameHex || '',
        entry.bodyHex || '',
        entry.bodyTextPreview || '',
        typeof entry.parseSuccess === 'boolean' ? entry.parseSuccess : null,
        entry.parseError || null,
        JSON.stringify(entry.parse || {})
      ]
    );
  }

  async list(options?: ListProtocolMessagesOptions): Promise<{ rows: any[]; total: number }> {
    if (!this.dbEnabled) {
      return { rows: [], total: 0 };
    }

    const where: string[] = [];
    const params: any[] = [];

    if (options?.vehicleId) {
      params.push(String(options.vehicleId).trim());
      where.push(`vehicle_id = $${params.length}`);
    }
    if (typeof options?.messageId === 'number' && Number.isFinite(options.messageId)) {
      params.push(Number(options.messageId));
      where.push(`message_id = $${params.length}`);
    }
    if (options?.direction) {
      params.push(options.direction);
      where.push(`direction = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(Number(options?.limit || 200), 5000));
    const offset = Math.max(0, Number(options?.offset || 0));

    const countSql = `SELECT COUNT(*)::int AS total FROM protocol_messages ${whereSql}`;
    const countRes = await query(countSql, params);
    const total = Number(countRes.rows?.[0]?.total || 0);

    const listParams = [...params, limit, offset];
    const rowsRes = await query(
      `SELECT
         id,
         received_at AS "receivedAt",
         direction,
         vehicle_id AS "vehicleId",
         message_id AS "messageId",
         message_id_hex AS "messageIdHex",
         serial_number AS "serialNumber",
         body_length AS "bodyLength",
         is_subpackage AS "isSubpackage",
         packet_count AS "packetCount",
         packet_index AS "packetIndex",
         raw_frame_hex AS "rawFrameHex",
         body_hex AS "bodyHex",
         body_text_preview AS "bodyTextPreview",
         parse_success AS "parseSuccess",
         parse_error AS "parseError",
         parse
       FROM protocol_messages
       ${whereSql}
       ORDER BY received_at DESC, id DESC
       LIMIT $${listParams.length - 1}
       OFFSET $${listParams.length}`,
      listParams
    );

    return { rows: rowsRes.rows, total };
  }
}
