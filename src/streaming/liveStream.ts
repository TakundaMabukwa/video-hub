import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { JTT808Server } from '../tcp/server';

type StreamMode = 'live' | 'replay';

interface StreamSubscription {
  vehicleId: string;
  channel: number;
  ws: WebSocket;
  lastFrame: Date;
  mode: StreamMode;
}

export class LiveVideoStreamServer {
  private wss: WebSocket.Server;
  private subscriptions = new Map<string, StreamSubscription[]>();
  private tcpServer: JTT808Server;
  private path: string;
  private keepStreamsWithoutClients: boolean;

  constructor(tcpServer: JTT808Server, path = '/ws/video') {
    this.tcpServer = tcpServer;
    this.path = path;
    this.keepStreamsWithoutClients = String(process.env.KEEP_STREAMS_WITHOUT_CLIENTS ?? 'false').toLowerCase() === 'true';
    this.wss = new WebSocket.Server({
      noServer: true
    });

    this.wss.on('connection', (ws) => {
      console.log('Video stream client connected');

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(ws, msg);
        } catch (error) {
          console.error('Invalid message:', error);
        }
      });

      ws.on('close', () => {
        this.unsubscribeAll(ws);
        console.log('Video stream client disconnected');
      });
    });

    console.log(`Live video WebSocket initialized on ${this.path}`);
  }

  public getPath(): string {
    return this.path;
  }

  public handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  private handleClientMessage(ws: WebSocket, msg: any) {
    switch (msg.type) {
      case 'subscribe':
        this.subscribe(ws, msg.vehicleId, msg.channel || 1, msg.mode === 'replay' ? 'replay' : 'live');
        break;
      case 'unsubscribe':
        this.unsubscribe(ws, msg.vehicleId, msg.channel || 1, msg.mode === 'replay' ? 'replay' : 'live');
        break;
    }
  }

  private buildKey(vehicleId: string, channel: number, mode: StreamMode) {
    return `${mode}:${vehicleId}_${channel}`;
  }

  private subscribe(ws: WebSocket, vehicleId: string, channel: number, mode: StreamMode) {
    const key = this.buildKey(vehicleId, channel, mode);

    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, []);
      if (mode === 'live') {
        this.tcpServer.startVideo(vehicleId, channel);
        console.log(`Started video stream: ${key}`);
      } else {
        console.log(`Replay subscription created: ${key}`);
      }
    }

    const subs = this.subscriptions.get(key)!;
    if (!subs.find(s => s.ws === ws)) {
      subs.push({ vehicleId, channel, ws, lastFrame: new Date(), mode });
      ws.send(JSON.stringify({ type: 'subscribed', vehicleId, channel, mode }));
      console.log(`Client subscribed to ${key}`);
    }
  }

  private unsubscribe(ws: WebSocket, vehicleId: string, channel: number, mode: StreamMode) {
    const key = this.buildKey(vehicleId, channel, mode);
    const subs = this.subscriptions.get(key);

    if (subs) {
      const filtered = subs.filter(s => s.ws !== ws);

      if (filtered.length === 0) {
        this.subscriptions.delete(key);
        if (mode === 'live') {
          if (!this.keepStreamsWithoutClients) {
            this.tcpServer.stopVideo(vehicleId, channel);
            console.log(`Stopped video stream: ${key}`);
          } else {
            console.log(`No subscribers for ${key}; keeping stream active (KEEP_STREAMS_WITHOUT_CLIENTS=true)`);
          }
        }
      } else {
        this.subscriptions.set(key, filtered);
      }
    }
  }

  private unsubscribeAll(ws: WebSocket) {
    for (const [key, subs] of this.subscriptions.entries()) {
      const filtered = subs.filter(s => s.ws !== ws);

      if (filtered.length === 0) {
        this.subscriptions.delete(key);
        const [modePart, vehiclePart] = key.split(':');
        const mode = modePart === 'replay' ? 'replay' : 'live';
        if (mode === 'live' && !this.keepStreamsWithoutClients) {
          const [vehicleId, channel] = vehiclePart.split('_');
          this.tcpServer.stopVideo(vehicleId, parseInt(channel));
        }
      } else {
        this.subscriptions.set(key, filtered);
      }
    }
  }

  broadcastFrame(vehicleId: string, channel: number, frame: Buffer, isIFrame: boolean, mode: StreamMode = 'live') {
    const key = this.buildKey(vehicleId, channel, mode);
    const subs = this.subscriptions.get(key);

    if (!subs || subs.length === 0) return;

    const message = JSON.stringify({
      type: 'frame',
      vehicleId,
      channel,
      mode,
      data: frame.toString('base64'),
      size: frame.length,
      isIFrame,
      timestamp: Date.now()
    });

    let sent = 0;
    for (const sub of subs) {
      if (sub.ws.readyState === WebSocket.OPEN) {
        sub.ws.send(message);
        sub.lastFrame = new Date();
        sent++;
      }
    }

    if (sent > 0 && isIFrame) {
      console.log(`Broadcast I-frame to ${sent} clients: ${key}`);
    }
  }

  getStats() {
    const stats: any = {};
    for (const [key, subs] of this.subscriptions.entries()) {
      stats[key] = {
        subscribers: subs.length,
        lastFrame: subs[0]?.lastFrame
      };
    }
    return stats;
  }
}
