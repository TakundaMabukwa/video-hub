# Video Worker

This node receives RTP packets from the listener and runs:

- RTP parsing
- frame assembly
- HLS/video writing
- stream/replay related work

Deploy steps:

1. Copy repo to video worker server
2. Configure `.env`
3. Build:

```bash
npm run build
```

4. Start with PM2:

```bash
pm2 start split/video-worker/ecosystem.config.js --update-env
```

