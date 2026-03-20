module.exports = {
  apps: [{
    name: 'video-listener',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '700M',
    node_args: '--max-old-space-size=768',
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: 2
    }
  }]
};
