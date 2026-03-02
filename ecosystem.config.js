module.exports = {
  apps: [{
    name: 'video-server',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    node_args: '--max-old-space-size=512',
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: 1
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
