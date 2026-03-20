import express from 'express';
import { AlertManager } from '../alerts/alertManager';
import { TCPRTPHandler } from '../tcp/rtpHandler';
import { JTT808Server } from '../tcp/server';

function authorized(req: express.Request): boolean {
  const expected = String(process.env.INTERNAL_WORKER_TOKEN || '').trim();
  if (!expected) return true;
  return String(req.header('X-Internal-Token') || '').trim() === expected;
}

export function createInternalRoutes(
  alertManager: AlertManager,
  rtpHandler: TCPRTPHandler,
  tcpServer?: JTT808Server
): express.Router {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!authorized(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    next();
  });

  router.post('/ingest/location-alert', async (req, res) => {
    try {
      const sourceMessageId = String(req.body?.sourceMessageId || '0x0200');
      const alert = req.body?.alert;
      if (!alert || typeof alert !== 'object') {
        return res.status(400).json({ success: false, message: 'Missing alert payload' });
      }

      const normalized = {
        ...alert,
        sourceMessageId,
        timestamp: new Date(alert.timestamp)
      };

      await alertManager.processAlert(normalized as any);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to ingest location alert',
        error: error?.message || String(error)
      });
    }
  });

  router.post('/ingest/external-alert', async (req, res) => {
    try {
      const input = req.body?.input;
      if (!input || typeof input !== 'object') {
        return res.status(400).json({ success: false, message: 'Missing external alert payload' });
      }

      const normalized = {
        ...input,
        timestamp: input.timestamp ? new Date(input.timestamp) : new Date()
      };

      await alertManager.processExternalAlert(normalized as any);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to ingest external alert',
        error: error?.message || String(error)
      });
    }
  });

  router.post('/ingest/rtp', (req, res) => {
    try {
      const vehicleId = String(req.body?.vehicleId || '').trim();
      const packetBase64 = String(req.body?.packetBase64 || '').trim();
      if (!vehicleId || !packetBase64) {
        return res.status(400).json({ success: false, message: 'Missing vehicleId or packetBase64' });
      }

      const packet = Buffer.from(packetBase64, 'base64');
      rtpHandler.handleRTPPacket(packet, vehicleId);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to ingest RTP packet',
        error: error?.message || String(error)
      });
    }
  });

  router.post('/commands/request-screenshot', async (req, res) => {
    try {
      if (!tcpServer) {
        return res.status(400).json({ success: false, message: 'TCP command server unavailable' });
      }
      const vehicleId = String(req.body?.vehicleId || '').trim();
      const channel = Number(req.body?.channel || 1);
      const alertId = req.body?.alertId ? String(req.body.alertId) : undefined;
      if (!vehicleId) {
        return res.status(400).json({ success: false, message: 'Missing vehicleId' });
      }

      const result = await tcpServer.requestScreenshotWithFallback(vehicleId, channel, {
        fallback: true,
        fallbackDelayMs: 700,
        alertId,
        captureVideoEvidence: true,
        videoDurationSec: 8
      });
      return res.json({ success: true, result });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to request screenshot',
        error: error?.message || String(error)
      });
    }
  });

  router.post('/commands/request-camera-video', async (req, res) => {
    try {
      if (!tcpServer) {
        return res.status(400).json({ success: false, message: 'TCP command server unavailable' });
      }
      const vehicleId = String(req.body?.vehicleId || '').trim();
      const channel = Number(req.body?.channel || 1);
      const startTime = new Date(req.body?.startTime);
      const endTime = new Date(req.body?.endTime);

      if (!vehicleId || Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        return res.status(400).json({ success: false, message: 'Missing or invalid request payload' });
      }

      const result = tcpServer.scheduleCameraReportRequests(vehicleId, channel, startTime, endTime, {
        queryResources: true,
        requestDownload: false
      });
      return res.json({ success: true, result });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to request camera video',
        error: error?.message || String(error)
      });
    }
  });

  return router;
}
