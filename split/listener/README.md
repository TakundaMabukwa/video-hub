# Listener

This node accepts device traffic and forwards work to:

- alert worker
- video worker

Use `.env.example` as the base env.

Deploy steps:

1. Copy repo to listener server
2. Configure `.env`
3. Build:

```bash
npm run build
```

4. Start with PM2:

```bash
pm2 start split/listener/ecosystem.config.js --update-env
```

