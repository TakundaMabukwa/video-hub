import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
 
type BroadcastPayload = unknown;
 
export class DataWebSocketServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private path: string;
  private verbose = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.DATA_WS_VERBOSE_LOGS ?? 'false').trim().toLowerCase()
  );
 
  constructor(path = '/ws/data') {
    this.path = path;
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: {
        zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
        zlibInflateOptions: { chunkSize: 10 * 1024 },
        threshold: 1024
      }
    });
 
    this.wss.on('connection', (ws, req) => {
      this.clients.add(ws);
      if (this.verbose) {
        console.log(`[WS:data] client connected (${this.clients.size}) from ${req.socket.remoteAddress}`);
      }
      this.safeSend(ws, { type: 'hello', ts: Date.now() });
 
      ws.on('close', () => {
        this.clients.delete(ws);
        if (this.verbose) {
          console.log(`[WS:data] client disconnected (${this.clients.size})`);
        }
      });
 
      ws.on('error', (err) => {
        if (this.verbose) {
          console.error('[WS:data] client error:', err);
        }
      });
    });
 
    const interval = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, 25000);
 
    this.wss.on('close', () => clearInterval(interval));
    if (this.verbose) {
      console.log(`[WS:data] initialized on ${this.path}`);
    }
  }

  public getPath(): string {
    return this.path;
  }

  public handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }
 
  public broadcast(payload: BroadcastPayload) {
    const message = JSON.stringify(payload);
    let sent = 0;
    let skipped = 0;
 
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) {
        skipped++;
        continue;
      }

      try {
        ws.send(message);
        sent++;
      } catch {
        skipped++;
      }
    }
 
    if (this.verbose && (sent > 0 || skipped > 0)) {
      console.log(`[WS:data] broadcast -> sent=${sent} skipped=${skipped}`);
    }
  }
 
  public getClientCount() {
    return this.clients.size;
  }
 
  private safeSend(ws: WebSocket, payload: any) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
}
