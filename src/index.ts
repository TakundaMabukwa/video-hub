// import express from 'express';
// import { createServer } from 'http';
// import { JTT808Server } from './tcp/server';
// import { UDPRTPServer } from './udp/server';
// import { TCPRTPHandler } from './tcp/rtpHandler';
// import { createRoutes } from './api/routes';
// import { createAlertRoutes } from './api/alertRoutes';
// import { AlertWebSocketServer } from './api/websocket';
// import { DataWebSocketServer } from './api/dataWebsocket';
// import pool from './storage/database';
// import * as dotenv from 'dotenv';

// dotenv.config();

// const DATA_WS_PORT = parseInt(process.env.DATA_WS_PORT || '7080');
// const TCP_PORT = parseInt(process.env.TCP_PORT || '7611');
// const UDP_PORT = parseInt(process.env.UDP_PORT || '6611');
// const API_PORT = parseInt(process.env.API_PORT || '3000');
// const SERVER_IP = process.env.SERVER_IP || 'localhost';

// async function startServer() {
//   console.log('Starting JT/T 1078 Video Ingestion Server...');
  
//   try {
//     await pool.query('SELECT NOW()');
//     console.log('✅ Database connected successfully');
//   } catch (error) {
//     console.error('❌ Database connection failed:', error);
//     process.exit(1);
//   }
  
//   const app = express();
//   app.use(express.json());
//   app.use(express.static('public'));
  
//   const httpServer = createServer(app);
  
//   // Initialize data WebSocket on same HTTP server
//   const dataWsServer = new DataWebSocketServer(httpServer, '/ws/data');
  
//   const tcpServer = new JTT808Server(TCP_PORT, UDP_PORT);
//   const udpServer = new UDPRTPServer(UDP_PORT);
//   const tcpRTPHandler = new TCPRTPHandler();
  
//   const alertManager = tcpServer.getAlertManager();
//   udpServer.setAlertManager(alertManager);
  
//   tcpServer.setRTPHandler((buffer, vehicleId) => {
//     console.log(`📦 RTP: ${buffer.length} bytes from ${vehicleId}`);
//     tcpRTPHandler.handleRTPPacket(buffer, vehicleId);
//     dataWsServer.broadcast({ type: 'rtp', vehicleId, data: buffer.toString('base64'), size: buffer.length });
//   });
  
//   await tcpServer.start();
//   await udpServer.start();
  
//   app.use('/api', createRoutes(tcpServer, udpServer));
//   app.use('/api/alerts', createAlertRoutes());
  
//   app.get('/health', (req, res) => {
//     res.json({
//       status: 'healthy',
//       timestamp: new Date().toISOString(),
//       services: {
//         tcp: `listening on port ${TCP_PORT}`,
//         udp: `listening on port ${UDP_PORT}`,
//         api: `listening on port ${API_PORT}`
//       }
//     });
//   });
  
//   new AlertWebSocketServer(httpServer, alertManager);
  
//   httpServer.listen(API_PORT, () => {
//     console.log(`\n✅ REST API: http://localhost:${API_PORT}`);
//     console.log(`✅ Alert WS: ws://localhost:${API_PORT}/ws/alerts`);
//     console.log(`✅ Data WS: ws://localhost:${API_PORT}/ws/data`);
//     console.log(`✅ TCP: ${TCP_PORT} | UDP: ${UDP_PORT}\n`);
//   });
  
//   process.on('SIGINT', () => {
//     console.log('\nShutting down...');
//     process.exit(0);
//   });
// }

// startServer().catch((error) => {
//   console.error('Failed to start server:', error);
//   process.exit(1);
// });



import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { JTT808Server } from './tcp/server';
import { UDPRTPServer } from './udp/server';
import { TCPRTPHandler } from './tcp/rtpHandler';
import { createRoutes } from './api/routes';
import { createAlertRoutes } from './api/alertRoutes';
import { AlertWebSocketServer } from './api/websocket';
import { DataWebSocketServer } from './api/dataWebsocket';
import { ProtocolWebSocketServer } from './api/protocolWebsocket';
import { createInternalRoutes } from './api/internalRoutes';
import { ForwardingAlertManager } from './alerts/forwardingAlertManager';
import { LiveVideoStreamServer } from './streaming/liveStream';
import { SSEVideoStream } from './streaming/sseStream';
import { ReplayService } from './streaming/replay';
import { WorkerForwarder } from './services/workerForwarder';
import { RetentionService } from './storage/retentionService';
import pool, { ensureRuntimeSchema } from './storage/database';
import * as dotenv from 'dotenv';

dotenv.config();

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function buildCorsOriginConfig(): true | string[] {
  const raw = String(process.env.CORS_ORIGIN || '*').trim();
  if (!raw || raw === '*') return true;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Raw-only logging mode:
// - keeps raw ingest persisted via RawIngestLogger
// - suppresses noisy runtime console logs
const RAW_LOG_ONLY = String(process.env.RAW_LOG_ONLY ?? 'true').toLowerCase() !== 'false';
if (RAW_LOG_ONLY) {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
}

const TCP_PORT = parseInt(process.env.TCP_PORT || '7611');
const UDP_PORT = parseInt(process.env.UDP_PORT || '6611');
const API_PORT = parseInt(process.env.API_PORT || '3000');
const SERVER_IP = process.env.SERVER_IP || 'localhost';
const AUTO_SCREENSHOT_INTERVAL_MS = parseInt(process.env.AUTO_SCREENSHOT_INTERVAL_MS || '30000');
const AUTO_SCREENSHOT_FALLBACK_DELAY_MS = parseInt(process.env.AUTO_SCREENSHOT_FALLBACK_DELAY_MS || '600');
const INGRESS_ENABLED = envFlag('INGRESS_ENABLED', true);
const ALERT_PROCESSING_ENABLED = envFlag('ALERT_PROCESSING_ENABLED', true);
const VIDEO_PROCESSING_ENABLED = envFlag('VIDEO_PROCESSING_ENABLED', true);
const DB_ENABLED = envFlag('DB_ENABLED', ALERT_PROCESSING_ENABLED);
const SHOULD_USE_DB = DB_ENABLED;
const BACKGROUND_STREAMS_ENABLED = VIDEO_PROCESSING_ENABLED;
const KEEP_STREAMS_WITHOUT_CLIENTS = VIDEO_PROCESSING_ENABLED;
const AUTO_SCREENSHOT_FANOUT_ENABLED = envFlag('AUTO_SCREENSHOT_FANOUT_ENABLED', false);
const BACKGROUND_STREAM_INTERVAL_MS = parseInt(process.env.BACKGROUND_STREAM_INTERVAL_MS || '15000');
const BACKGROUND_STREAM_STALE_MS = parseInt(process.env.BACKGROUND_STREAM_STALE_MS || '30000');
const BACKGROUND_STREAM_DEFAULT_CHANNELS = String(
  process.env.BACKGROUND_STREAM_DEFAULT_CHANNELS || '1,2,3,4'
)
  .split(',')
  .map((value) => Number(String(value || '').trim()))
  .filter((value, index, arr) => Number.isFinite(value) && value > 0 && arr.indexOf(value) === index);
const ALERT_WORKER_URL = process.env.ALERT_WORKER_URL || '';
const VIDEO_WORKER_URL = process.env.VIDEO_WORKER_URL || '';
const LISTENER_SERVER_URL = process.env.LISTENER_SERVER_URL || '';
const INTERNAL_WORKER_TOKEN = process.env.INTERNAL_WORKER_TOKEN || '';
const WORKER_FORWARD_TIMEOUT_MS = parseInt(process.env.WORKER_FORWARD_TIMEOUT_MS || '15000');
const WORKER_FORWARD_FAILURE_THRESHOLD = parseInt(process.env.WORKER_FORWARD_FAILURE_THRESHOLD || '5');
const WORKER_FORWARD_RECOVERY_COOLDOWN_MS = parseInt(process.env.WORKER_FORWARD_RECOVERY_COOLDOWN_MS || '300000');
const ALERT_WORKER_RECOVERY_COMMAND = process.env.ALERT_WORKER_RECOVERY_COMMAND || '';
const VIDEO_WORKER_RECOVERY_COMMAND = process.env.VIDEO_WORKER_RECOVERY_COMMAND || '';
const LISTENER_SERVER_RECOVERY_COMMAND = process.env.LISTENER_SERVER_RECOVERY_COMMAND || '';
const MESSAGE_TRACE_ENABLED = envFlag(
  'MESSAGE_TRACE_ENABLED',
  INGRESS_ENABLED && (ALERT_PROCESSING_ENABLED || VIDEO_PROCESSING_ENABLED)
);
const DATA_WS_ENABLED = envFlag(
  'DATA_WS_ENABLED',
  MESSAGE_TRACE_ENABLED
);
const PROTOCOL_WS_ENABLED = envFlag(
  'PROTOCOL_WS_ENABLED',
  MESSAGE_TRACE_ENABLED
);

async function startServer() {
  console.log('Starting JT/T 1078 Video Ingestion Server...');
  
  if (SHOULD_USE_DB) {
    try {
      await pool.query('SELECT NOW()');
      await ensureRuntimeSchema();
      console.log('Database connected successfully');
    } catch (error) {
      console.error('Database connection failed:', error);
      process.exit(1);
    }
  } else {
    console.log('Database startup checks skipped for listener-only mode');
  }
  
  const tcpServer = new JTT808Server(TCP_PORT, UDP_PORT);
  const udpServer = new UDPRTPServer(UDP_PORT);
  const tcpRTPHandler = new TCPRTPHandler();
  const retentionService = new RetentionService();
  const workerForwarder = new WorkerForwarder({
    alertWorkerUrl: ALERT_WORKER_URL,
    videoWorkerUrl: VIDEO_WORKER_URL,
    listenerServerUrl: LISTENER_SERVER_URL,
    authToken: INTERNAL_WORKER_TOKEN,
    forwardTimeoutMs: WORKER_FORWARD_TIMEOUT_MS,
    failureThreshold: WORKER_FORWARD_FAILURE_THRESHOLD,
    recoveryCooldownMs: WORKER_FORWARD_RECOVERY_COOLDOWN_MS,
    alertWorkerRecoveryCommand: ALERT_WORKER_RECOVERY_COMMAND,
    videoWorkerRecoveryCommand: VIDEO_WORKER_RECOVERY_COMMAND,
    listenerServerRecoveryCommand: LISTENER_SERVER_RECOVERY_COMMAND
  });
  
  let alertManager = tcpServer.getAlertManager();
  if (!ALERT_PROCESSING_ENABLED && workerForwarder.hasAlertWorker()) {
    alertManager = new ForwardingAlertManager(workerForwarder);
    tcpServer.setAlertManager(alertManager);
  }
  if (INGRESS_ENABLED && ALERT_PROCESSING_ENABLED) {
    tcpServer.attachAlertCommandBridge(alertManager);
  }
  if (!INGRESS_ENABLED && ALERT_PROCESSING_ENABLED && workerForwarder.hasListenerServer()) {
    alertManager.on('request-screenshot', ({ vehicleId, channel, alertId }) => {
      void workerForwarder.requestScreenshot(vehicleId, channel, alertId);
    });
    alertManager.on('request-camera-video', ({ vehicleId, channel, startTime, endTime, alertId }) => {
      void workerForwarder.requestCameraVideo(vehicleId, channel, new Date(startTime), new Date(endTime), alertId);
    });
  }
  udpServer.setAlertManager(alertManager);
  udpServer.setVehicleIdResolver((ipAddress) => tcpServer.resolveVehicleIdByIp(ipAddress));
  if (ALERT_PROCESSING_ENABLED && VIDEO_PROCESSING_ENABLED) {
    tcpRTPHandler.setAlertManager(alertManager);
  }
  
  const app = express();
  
  // Enable CORS for Next.js frontend
  app.use(cors({
    origin: buildCorsOriginConfig(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  }));
  
  app.use(express.json());
  app.use(express.static('public'));
  app.use('/hls', express.static('hls'));
  
  const httpServer = createServer(app);
  const dataWsServer = INGRESS_ENABLED && DATA_WS_ENABLED ? new DataWebSocketServer('/ws/data') : null;
  const protocolWsServer = INGRESS_ENABLED && PROTOCOL_WS_ENABLED
    ? new ProtocolWebSocketServer([
        '0x0001',
        '0x8001',
        '0x0002',
        '0x0100',
        '0x8100',
        '0x0102',
        '0x8103',
        '0x8104',
        '0x8106',
        '0x0200',
        '0x0201',
        '0x0704',
        '0x0301',
        '0x0302',
        '0x0700',
        '0x0702',
        '0x0800',
        '0x0801',
        '0x0802',
        '0x0900',
        '0x1001',
        '0x1003',
        '0x1205',
        '0x9205',
        '0x9101',
        '0x9102',
        '0x9103',
        '0x9105',
        '0x9106',
        '0x9201',
        '0x9301'
      ], '/ws/protocol')
    : null;
  const liveVideoServer = new LiveVideoStreamServer(tcpServer, '/ws/video');
  const sseVideoStream = new SSEVideoStream(tcpServer);
  const replayService = new ReplayService(liveVideoServer);
  
  // Connect UDP frames to WebSocket and SSE broadcast
  if (VIDEO_PROCESSING_ENABLED) {
    udpServer.setFrameCallback((vehicleId, channel, frame, isIFrame) => {
      liveVideoServer.broadcastFrame(vehicleId, channel, frame, isIFrame);
      sseVideoStream.broadcastFrame(vehicleId, channel, frame, isIFrame);
    });
  }
  
  // Connect TCP RTP frames to WebSocket and SSE broadcast
  if (VIDEO_PROCESSING_ENABLED) {
    tcpRTPHandler.setFrameCallback((vehicleId, channel, frame, isIFrame) => {
      console.log(`🔄 TCP Frame callback triggered: ${vehicleId}_ch${channel}, size=${frame.length}, isIFrame=${isIFrame}`);
      liveVideoServer.broadcastFrame(vehicleId, channel, frame, isIFrame);
      sseVideoStream.broadcastFrame(vehicleId, channel, frame, isIFrame);
    });
    tcpServer.setRTPHandler((buffer, vehicleId) => {
      console.log(`📦 TCP RTP handler called: vehicleId=${vehicleId}, size=${buffer.length}`);
      tcpRTPHandler.handleRTPPacket(buffer, vehicleId);
    });
  } else if (workerForwarder.hasVideoWorker()) {
    udpServer.setPacketForwarder((packet, vehicleId) => {
      void workerForwarder.forwardRtpPacket(packet, vehicleId, 'udp');
    });
    tcpServer.setRTPHandler((buffer, vehicleId) => {
      void workerForwarder.forwardRtpPacket(buffer, vehicleId, 'tcp');
    });
  }

  if (MESSAGE_TRACE_ENABLED && dataWsServer && protocolWsServer) {
    tcpServer.setMessageTraceCallback((trace) => {
      dataWsServer.broadcast({
        type: 'PROTOCOL_MESSAGE',
        trace
      });
      protocolWsServer.broadcastTrace(trace);
    });
  }
  
  if (INGRESS_ENABLED) {
    await tcpServer.start();
    await udpServer.start();
  }
  if (VIDEO_PROCESSING_ENABLED && SHOULD_USE_DB) {
    retentionService.start();
  }

  console.log(
    `Background capture mode: streams=${BACKGROUND_STREAMS_ENABLED ? 'on' : 'off'}, keepWithoutClients=${KEEP_STREAMS_WITHOUT_CLIENTS ? 'on' : 'off'}, screenshotFanout=${AUTO_SCREENSHOT_FANOUT_ENABLED ? 'on' : 'off'}`
  );
  
  app.use('/api', createRoutes(tcpServer, udpServer, replayService, workerForwarder));
  if (ALERT_PROCESSING_ENABLED) {
    app.use('/api/alerts', createAlertRoutes());
  }
  app.use('/api/internal', createInternalRoutes(alertManager, tcpRTPHandler, tcpServer));
  
  app.get('/health', (req, res) => {
    const dbStats = SHOULD_USE_DB
      ? require('./storage/database').getPoolStats()
      : null;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        tcp: INGRESS_ENABLED ? `listening on port ${TCP_PORT}` : 'disabled',
        udp: INGRESS_ENABLED ? `listening on port ${UDP_PORT}` : 'disabled',
        api: `listening on port ${API_PORT}`
      },
      mode: {
        ingressEnabled: INGRESS_ENABLED,
        alertProcessingEnabled: ALERT_PROCESSING_ENABLED,
        videoProcessingEnabled: VIDEO_PROCESSING_ENABLED,
        alertWorkerUrl: ALERT_WORKER_URL || null,
        videoWorkerUrl: VIDEO_WORKER_URL || null,
        listenerServerUrl: LISTENER_SERVER_URL || null
      },
      database: SHOULD_USE_DB ? {
        pool: dbStats,
        warning: dbStats.waiting > 0 ? `${dbStats.waiting} queries waiting for a connection` : null,
        alert: dbStats.active > dbStats.max * 0.9 ? `Pool is ${Math.round((dbStats.active/dbStats.max)*100)}% utilized` : null
      } : {
        enabled: false
      }
    });
  });
  
  // Database pool status endpoint (for monitoring)
  app.get('/api/db/pool-status', (req, res) => {
    if (!SHOULD_USE_DB) {
      return res.json({
        timestamp: new Date().toISOString(),
        enabled: false,
        message: 'Database disabled in listener-only mode'
      });
    }
    const { getPoolStats } = require('./storage/database');
    const stats = getPoolStats();
    
    res.json({
      timestamp: new Date().toISOString(),
      pool: stats,
      utilization: {
        percentage: Math.round((stats.active / stats.max) * 100),
        active: stats.active,
        idle: stats.idle,
        waiting: stats.waiting,
        max: stats.max
      },
      warnings: [
        ...(stats.waiting > 0 ? [`${stats.waiting} queries waiting for connection`] : []),
        ...(stats.active > stats.max * 0.8 ? [`Connection pool is ${Math.round((stats.active/stats.max)*100)}% utilized`] : []),
        ...(stats.idle === 0 && stats.active > 0 ? [`No idle connections available`] : [])
      ]
    });
  });
  
  app.get('/api/stream/stats', (req, res) => {
    res.json({
      websocket: liveVideoServer.getStats(),
      sse: sseVideoStream.getStats()
    });
  });
  
  app.get('/api/stream/sse', (req, res) => {
    sseVideoStream.handleConnection(req, res);
  });
  
  // Test endpoint to check if SSE broadcast works
  app.get('/api/stream/test', (req, res) => {
    const testFrame = Buffer.from('TEST_FRAME_DATA');
    console.log('🧪 Manual test broadcast triggered');
    sseVideoStream.broadcastFrame('TEST_VEHICLE', 1, testFrame, true);
    res.json({ message: 'Test frame broadcasted', clients: sseVideoStream.getStats() });
  });
  
  app.get('/api/vehicles/connected', (req, res) => {
    const vehicles = tcpServer.getVehicles().filter(v => v.connected);
    res.json(vehicles.map(v => ({
      id: v.id,
      phone: v.phone,
      channels: v.channels || [],
      activeStreams: Array.from(v.activeStreams)
    })));
  });
  
  const wsServer = ALERT_PROCESSING_ENABLED ? new AlertWebSocketServer(alertManager, '/ws/alerts') : null;

  // Single upgrade router for all websocket paths.
  httpServer.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try {
      const host = request.headers.host || 'localhost';
      pathname = new URL(request.url || '', `http://${host}`).pathname;
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (wsServer && pathname === wsServer.getPath()) {
      wsServer.handleUpgrade(request, socket, head);
      return;
    }
    if (dataWsServer && pathname === dataWsServer.getPath()) {
      dataWsServer.handleUpgrade(request, socket, head);
      return;
    }
    if (protocolWsServer && protocolWsServer.handleUpgrade(request, socket, head, pathname)) {
      return;
    }
    if (pathname === liveVideoServer.getPath()) {
      liveVideoServer.handleUpgrade(request, socket, head);
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  // Keep camera streams alive in backend mode (independent of UI subscribers).
  const getBackgroundChannels = (vehicle: any) => {
    const fromCapabilities = (vehicle.channels || [])
      .filter((ch: any) => ch.type === 'video' || ch.type === 'audio_video')
      .map((ch: any) => Number(ch.logicalChannel))
      .filter((ch: number) => Number.isFinite(ch) && ch > 0);

    return [...new Set(fromCapabilities.length ? fromCapabilities : BACKGROUND_STREAM_DEFAULT_CHANNELS)];
  };

  const ensureBackgroundStreams = () => {
    if (!BACKGROUND_STREAMS_ENABLED) return;
    const connected = tcpServer.getVehicles().filter(v => v.connected);
    for (const v of connected) {
      const channels = getBackgroundChannels(v);
      for (const channel of channels) {
        tcpServer.startVideo(String(v.id), channel);
      }
    }
  };

  const ensureFreshBackgroundStreams = () => {
    if (!BACKGROUND_STREAMS_ENABLED) return;
    const connected = tcpServer.getVehicles().filter(v => v.connected);
    const now = Date.now();

    for (const v of connected) {
      const channels = getBackgroundChannels(v);
      for (const channel of channels) {
        const streamInfo = udpServer.getStreamInfo(String(v.id), channel);
        const lastFrameAt = streamInfo?.lastFrame ? new Date(streamInfo.lastFrame).getTime() : 0;
        const hasFreshFrames = !!lastFrameAt && Number.isFinite(lastFrameAt) && now - lastFrameAt <= BACKGROUND_STREAM_STALE_MS;
        if (!streamInfo?.active || !hasFreshFrames) {
          tcpServer.startVideo(String(v.id), channel);
        }
      }
    }
  };

  // Server-side screenshot fanout scheduler: keep recent screenshots updated for all connected vehicles/channels.
  const runAutoScreenshotFanout = async () => {
    if (!AUTO_SCREENSHOT_FANOUT_ENABLED) {
      return;
    }
    const connected = tcpServer.getVehicles().filter(v => v.connected);
    if (connected.length === 0) {
      return;
    }

    const targets: Array<{ vehicleId: string; channel: number }> = [];
    for (const v of connected) {
      const fromCapabilities = (v.channels || [])
        .filter(ch => ch.type === 'video' || ch.type === 'audio_video')
        .map(ch => Number(ch.logicalChannel))
        .filter(ch => Number.isFinite(ch) && ch > 0);

      const fromActiveStreams = Array.from(v.activeStreams)
        .map(ch => Number(ch))
        .filter(ch => Number.isFinite(ch) && ch > 0);

      const channels = [...new Set(fromCapabilities.length ? fromCapabilities : (fromActiveStreams.length ? fromActiveStreams : [1, 2]))];
      for (const channel of channels) {
        targets.push({ vehicleId: String(v.id), channel });
      }
    }

    if (targets.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      targets.map(t =>
        tcpServer.requestScreenshotWithFallback(t.vehicleId, t.channel, {
          fallback: true,
          fallbackDelayMs: AUTO_SCREENSHOT_FALLBACK_DELAY_MS
        })
      )
    );

    const ok = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const fail = results.length - ok;
    console.log(`Auto screenshot fanout: ${ok} success, ${fail} failed`);
  };

  if (BACKGROUND_STREAMS_ENABLED || AUTO_SCREENSHOT_FANOUT_ENABLED) {
    setTimeout(() => {
      ensureBackgroundStreams();
      ensureFreshBackgroundStreams();
      void runAutoScreenshotFanout();
    }, 5000);
  }

  if (BACKGROUND_STREAMS_ENABLED) {
    setInterval(() => {
      ensureBackgroundStreams();
      ensureFreshBackgroundStreams();
    }, BACKGROUND_STREAM_INTERVAL_MS);
  }

  if (AUTO_SCREENSHOT_FANOUT_ENABLED) {
    setInterval(() => {
      void runAutoScreenshotFanout();
    }, AUTO_SCREENSHOT_INTERVAL_MS);
  }
  
  // Alert reminder scheduler - Check for unattended alerts every 5 minutes
  if (ALERT_PROCESSING_ENABLED && SHOULD_USE_DB) {
    setInterval(async () => {
      try {
        const { AlertStorageDB } = require('./storage/alertStorageDB');
        const alertStorage = new AlertStorageDB();
        const unattended = await alertStorage.getUnattendedAlerts(30);
        
        if (unattended.length > 0) {
          console.log(`⏰ REMINDER: ${unattended.length} unattended alerts`);
          wsServer?.broadcast({
            type: 'alert-reminder',
            count: unattended.length,
            alerts: unattended.map((a: any) => ({
              id: a.id,
              type: a.alert_type,
              priority: a.priority,
              timestamp: a.timestamp,
              vehicleId: a.device_id
            }))
          });
        }
      } catch (error) {
        console.error('Alert reminder error:', error);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }
  
  httpServer.listen(API_PORT, '0.0.0.0', () => {
    console.log(`REST API server listening on port ${API_PORT}`);
    if (ALERT_PROCESSING_ENABLED) {
      console.log(`WebSocket - Alerts: ws://localhost:${API_PORT}/ws/alerts`);
    }
    if (INGRESS_ENABLED && DATA_WS_ENABLED) {
      console.log(`WebSocket - Data: ws://localhost:${API_PORT}/ws/data`);
    }
    if (INGRESS_ENABLED && PROTOCOL_WS_ENABLED) {
      console.log(`WebSocket - Protocol All: ws://localhost:${API_PORT}/ws/protocol/all`);
      console.log(`WebSocket - Protocol 0x1205: ws://localhost:${API_PORT}/ws/protocol/0x1205`);
    }
    if (VIDEO_PROCESSING_ENABLED) {
      console.log(`WebSocket - Live Video: ws://localhost:${API_PORT}/ws/video`);
    }
  });
  
  console.log('\n=== JT/T 1078 Video Server Started ===');
  console.log(`API: ${API_PORT}`);
  if (INGRESS_ENABLED) {
    console.log(`TCP: ${TCP_PORT} | UDP: ${UDP_PORT}`);
  }
  if (VIDEO_PROCESSING_ENABLED) {
    console.log(`Live Stream: ws://localhost:${API_PORT}/ws/video`);
    console.log(`SSE Test: http://localhost:${API_PORT}/api/stream/test`);
  }
  console.log('==========================================\n');
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    
    // Close database pool
    const { closePool } = await import('./storage/database');
    await closePool();
    
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\nTerminating server...');
    
    // Close database pool
    const { closePool } = await import('./storage/database');
    await closePool();
    
    process.exit(0);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
