module.exports = {
  apps: [{
    name: "wa-corporate-dashboard",
    script: "src/server.js",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    env: {
      NODE_ENV: "production",
      PORT: 8300,
      LOG_LEVEL: "warn",
    },
    out_file: "./logs/app-out.log",
    error_file: "./logs/app-error.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    merge_logs: true,
  }],
};
