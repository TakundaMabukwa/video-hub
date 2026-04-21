import { isDatabaseEnabled, query } from './database';
import { AlertEvent } from '../alerts/alertManager';

export class AlertStorageDB {
  private readonly dbEnabled = isDatabaseEnabled();

  private normalizePriority(value?: string | null): 'low' | 'medium' | 'high' | 'critical' {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
      return normalized;
    }
    return 'high';
  }

  private async ensureAlertExistsForClosure(input: {
    alertId: string;
    closureType: 'resolved' | 'false_alert' | 'ncr' | 'report';
    notes: string;
    actor?: string;
    reasonCode?: string;
    reasonLabel?: string;
    documentUrl?: string;
    documentName?: string;
    documentType?: string;
    payload?: Record<string, any>;
  }): Promise<boolean> {
    const payload = input.payload || {};
    const metadata = payload?.savedArtifact?.closurePayload || {};
    const deviceId = String(
      payload?.deviceId ||
      metadata?.deviceId ||
      payload?.vehicleId ||
      metadata?.vehicleId ||
      ''
    ).trim();
    const alertType = String(
      payload?.alertType ||
      metadata?.alertType ||
      'manual_closure'
    ).trim() || 'manual_closure';
    const channel = Number(
      payload?.channel ??
      metadata?.channel ??
      1
    );
    const priority = this.normalizePriority(
      payload?.severity ||
      metadata?.severity ||
      'high'
    );
    const timestampSource =
      payload?.timestamp ||
      metadata?.timestamp ||
      new Date().toISOString();
    const parsedTimestamp = new Date(timestampSource);
    const timestamp = Number.isNaN(parsedTimestamp.getTime())
      ? new Date().toISOString()
      : parsedTimestamp.toISOString();
    const latitude = Number(payload?.coordinates?.latitude ?? metadata?.coordinates?.latitude);
    const longitude = Number(payload?.coordinates?.longitude ?? metadata?.coordinates?.longitude);
    const closureSubtype =
      input.closureType === 'resolved' ? 'manual' : input.closureType;
    const isFalse = input.closureType === 'false_alert';

    if (!deviceId || !Number.isFinite(channel) || channel <= 0) {
      return false;
    }

    const deviceExists = await query(
      `SELECT 1 FROM devices WHERE device_id = $1 LIMIT 1`,
      [deviceId]
    );
    if ((deviceExists.rowCount || 0) === 0) {
      return false;
    }

    await query(
      `INSERT INTO alerts (
         id, device_id, channel, alert_type, priority, status, resolved,
         escalation_level, timestamp, latitude, longitude, metadata,
         repeated_count, last_occurrence, resolved_at, resolution_notes,
         resolved_by, closure_type, closure_subtype, resolution_reason_code,
         resolution_reason_label, is_false_alert, false_alert_reason,
         false_alert_reason_code, ncr_document_url, ncr_document_name,
         report_document_url, report_document_name, report_document_type,
         closure_payload
       )
       VALUES (
         $1, $2, $3, $4, $5, 'resolved', TRUE,
         0, $6, $7, $8, $9::jsonb,
         1, $6, NOW(), $10,
         $11, $12, $13, $14,
         $15, $16, CASE WHEN $16 THEN $10 ELSE NULL END,
         CASE WHEN $16 THEN $14 ELSE NULL END,
         CASE WHEN $12 = 'ncr' THEN $17 ELSE NULL END,
         CASE WHEN $12 = 'ncr' THEN $18 ELSE NULL END,
         CASE WHEN $12 = 'report' THEN $17 ELSE NULL END,
         CASE WHEN $12 = 'report' THEN $18 ELSE NULL END,
         CASE WHEN $12 = 'report' THEN $19 ELSE NULL END,
         $20::jsonb
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        input.alertId,
        deviceId,
        channel,
        alertType,
        priority,
        timestamp,
        Number.isFinite(latitude) ? latitude : null,
        Number.isFinite(longitude) ? longitude : null,
        JSON.stringify(payload || {}),
        input.notes,
        input.actor || null,
        input.closureType === 'resolved' ? 'manual' : input.closureType,
        closureSubtype,
        input.reasonCode || null,
        input.reasonLabel || null,
        isFalse,
        input.documentUrl || null,
        input.documentName || null,
        input.documentType || null,
        JSON.stringify(payload || {})
      ]
    );

    const exists = await query(`SELECT 1 FROM alerts WHERE id = $1`, [input.alertId]);
    return (exists.rowCount || 0) > 0;
  }

  private async recordResolutionEvent(
    alertId: string,
    data: {
      actionType: string;
      actor?: string;
      notes?: string;
      reasonCode?: string;
      reasonLabel?: string;
      closureType?: string;
      documentUrl?: string;
      documentName?: string;
      documentType?: string;
      payload?: Record<string, any>;
    }
  ): Promise<void> {
    if (!this.dbEnabled) return;
    await query(
      `INSERT INTO alert_resolution_events
       (alert_id, action_type, actor, notes, reason_code, reason_label, closure_type, document_url, document_name, document_type, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        alertId,
        data.actionType,
        data.actor || null,
        data.notes || null,
        data.reasonCode || null,
        data.reasonLabel || null,
        data.closureType || null,
        data.documentUrl || null,
        data.documentName || null,
        data.documentType || null,
        JSON.stringify(data.payload || {})
      ]
    );
  }

  async closeAlertWithDetails(input: {
    alertId: string;
    closureType: 'resolved' | 'false_alert' | 'ncr' | 'report';
    notes: string;
    actor?: string;
    reasonCode?: string;
    reasonLabel?: string;
    documentUrl?: string;
    documentName?: string;
    documentType?: string;
    payload?: Record<string, any>;
  }): Promise<boolean> {
    if (!this.dbEnabled) return false;
    const closureSubtype =
      input.closureType === 'resolved' ? 'manual' : input.closureType;
    const isFalse = input.closureType === 'false_alert';

    const result = await query(
      `UPDATE alerts
       SET status = 'resolved',
           resolved = TRUE,
           resolved_at = NOW(),
           resolution_notes = $1,
           resolved_by = $2,
           closure_type = $3,
           closure_subtype = $4,
           resolution_reason_code = $5,
           resolution_reason_label = $6,
           is_false_alert = $7,
           false_alert_reason = CASE WHEN $7 THEN $1 ELSE false_alert_reason END,
           false_alert_reason_code = CASE WHEN $7 THEN $5 ELSE false_alert_reason_code END,
           ncr_document_url = CASE WHEN $3 = 'ncr' THEN $8 ELSE ncr_document_url END,
           ncr_document_name = CASE WHEN $3 = 'ncr' THEN $9 ELSE ncr_document_name END,
           report_document_url = CASE WHEN $3 = 'report' THEN $8 ELSE report_document_url END,
           report_document_name = CASE WHEN $3 = 'report' THEN $9 ELSE report_document_name END,
           report_document_type = CASE WHEN $3 = 'report' THEN $10 ELSE report_document_type END,
           closure_payload = COALESCE($11::jsonb, '{}'::jsonb)
       WHERE id = $12`,
      [
        input.notes,
        input.actor || null,
        input.closureType === 'resolved' ? 'manual' : input.closureType,
        closureSubtype,
        input.reasonCode || null,
        input.reasonLabel || null,
        isFalse,
        input.documentUrl || null,
        input.documentName || null,
        input.documentType || null,
        JSON.stringify(input.payload || {}),
        input.alertId
      ]
    );

    let ok = (result.rowCount || 0) > 0;
    if (!ok) {
      const inserted = await this.ensureAlertExistsForClosure(input);
      if (inserted) {
        ok = true;
      }
    }
    if (ok) {
      await this.recordResolutionEvent(input.alertId, {
        actionType: input.closureType === 'resolved' ? 'resolved' : input.closureType,
        actor: input.actor,
        notes: input.notes,
        reasonCode: input.reasonCode,
        reasonLabel: input.reasonLabel,
        closureType: input.closureType,
        documentUrl: input.documentUrl,
        documentName: input.documentName,
        documentType: input.documentType,
        payload: input.payload
      });
    }
    return ok;
  }

  async saveAlert(alert: AlertEvent) {
    if (!this.dbEnabled) return;
    // DEDUPLICATION: Check if similar alert exists within last 60 seconds
    // If yes, just increment counter (UPDATE = 50x faster than INSERT)
    // If no, insert as new alert
    
    const recentAlert = await query(
      `SELECT id FROM alerts 
       WHERE device_id = $1 
         AND channel = $2 
         AND alert_type = $3
         AND timestamp > NOW() - INTERVAL '60 seconds'
       ORDER BY timestamp DESC 
       LIMIT 1`,
      [alert.vehicleId, alert.channel, alert.type]
    );

    if (recentAlert.rows.length > 0) {
      // DUPLICATE ALERT: Just update the count (fast UPDATE instead of INSERT)
      await query(
        `UPDATE alerts 
         SET repeated_count = COALESCE(repeated_count, 0) + 1,
             last_occurrence = NOW(),
             metadata = $1,
             timestamp = GREATEST(timestamp, $2)
         WHERE id = $3`,
        [
          JSON.stringify(alert.metadata),
          alert.timestamp,
          recentAlert.rows[0].id
        ]
      );
    } else {
      // NEW ALERT: Insert as normal
      await query(
        `INSERT INTO alerts (id, device_id, channel, alert_type, priority, status, resolved, escalation_level, timestamp, latitude, longitude, metadata, repeated_count, last_occurrence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           resolved = EXCLUDED.resolved,
           escalation_level = EXCLUDED.escalation_level,
           acknowledged_at = EXCLUDED.acknowledged_at,
           resolved_at = EXCLUDED.resolved_at,
           metadata = EXCLUDED.metadata,
           repeated_count = EXCLUDED.repeated_count`,
        [
          alert.id,
          alert.vehicleId,
          alert.channel,
          alert.type,
          alert.priority,
          alert.status,
          alert.status === 'resolved',
          alert.escalationLevel,
          alert.timestamp,
          alert.location.latitude,
          alert.location.longitude,
          JSON.stringify(alert.metadata),
          1,  // initial count
          alert.timestamp  // last_occurrence
        ]
      );
    }
  }

  async updateAlertStatus(alertId: string, status: string, acknowledgedAt?: Date, resolvedAt?: Date, notes?: string, resolvedBy?: string) {
    if (!this.dbEnabled) return;
    await query(
      `UPDATE alerts
       SET status = $1,
           resolved = CASE WHEN $1 = 'resolved' THEN TRUE ELSE FALSE END,
           acknowledged_at = $2,
           resolved_at = $3,
           resolution_notes = $4,
           resolved_by = $5
       WHERE id = $6`,
      [status, acknowledgedAt, resolvedAt, notes, resolvedBy, alertId]
    );
  }

  async resolveWithNcr(
    alertId: string,
    notes: string,
    resolvedBy?: string,
    ncrDocumentUrl?: string,
    ncrDocumentName?: string
  ): Promise<boolean> {
    return this.closeAlertWithDetails({
      alertId,
      closureType: 'ncr',
      notes,
      actor: resolvedBy,
      documentUrl: ncrDocumentUrl,
      documentName: ncrDocumentName,
      documentType: 'ncr'
    });
  }

  async markAsFalseAlert(
    alertId: string,
    reason: string,
    markedBy?: string,
    reasonCode?: string
  ): Promise<boolean> {
    return this.closeAlertWithDetails({
      alertId,
      closureType: 'false_alert',
      notes: reason,
      actor: markedBy,
      reasonCode,
      reasonLabel: reason
    });
  }

  async getUnattendedAlerts(minutesThreshold: number = 30) {
    if (!this.dbEnabled) return [];
    const cutoff = new Date(Date.now() - minutesThreshold * 60000);
    const result = await query(
      `SELECT * FROM alerts 
       WHERE status = 'new' AND timestamp < $1 
       ORDER BY priority DESC, timestamp ASC`,
      [cutoff]
    );
    return result.rows;
  }

  async getActiveAlerts() {
    if (!this.dbEnabled) return [];
    const result = await query(
      `SELECT * FROM alerts WHERE status IN ('new', 'escalated', 'acknowledged') ORDER BY timestamp DESC`
    );
    return result.rows;
  }

  async getAlertById(alertId: string) {
    if (!this.dbEnabled) return null;
    const result = await query(`SELECT * FROM alerts WHERE id = $1`, [alertId]);
    return result.rows[0];
  }

  async updateAlertMetadata(alertId: string, metadata: Record<string, any>): Promise<boolean> {
    if (!this.dbEnabled) return false;
    const result = await query(
      `UPDATE alerts
       SET metadata = $1
       WHERE id = $2`,
      [JSON.stringify(metadata || {}), alertId]
    );
    return (result.rowCount || 0) > 0;
  }

  async getAlertWithVideos(alertId: string) {
    if (!this.dbEnabled) return null;
    const result = await query(
      `SELECT a.*,
         (SELECT file_path FROM videos WHERE alert_id = a.id AND video_type = 'alert_pre') as pre_video_path,
         (SELECT file_path FROM videos WHERE alert_id = a.id AND video_type = 'alert_post') as post_video_path
       FROM alerts a WHERE a.id = $1`,
      [alertId]
    );
    return result.rows[0];
  }
}
