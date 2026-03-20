# Alert Worker

This node receives parsed alert payloads from the listener and runs:

- alert creation
- alert persistence
- alert websocket/api

Deploy steps:

1. Copy repo to alert worker server
2. Configure `.env`
3. Build:

```bash
npm run build
```

4. Start with PM2:

```bash
pm2 start split/alert-worker/ecosystem.config.js --update-env
```

