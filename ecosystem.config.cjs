module.exports = {
  apps: [
    {
      name: 'necom-data-mcp',
      cwd: __dirname,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork', // OAuth-state och MCP-sessioner ligger i minnet/fil – kör EN instans
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
  ],
};
