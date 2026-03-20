module.exports = {
  apps: [{
    name: 'video-video-worker',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '1200M',
    node_args: '--max-old-space-size=1536',
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: 4
    }
  }]
};
