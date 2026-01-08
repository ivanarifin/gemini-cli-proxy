/**
 * PM2 ecosystem configuration for gemini-cli-proxy
 *
 * Usage:
 *   1. Edit this file to set your OAuth rotation folder path
 *   2. Run: pm2 start ecosystem.config.cjs
 *   3. Run: pm2 save (to save process list for auto-restart)
 *   4. Run: pm2 startup (and follow instructions for boot persistence)
 */

module.exports = {
  apps: [
    {
      name: "gemini-proxy",
      script: "dist/index.js",
      cwd: "/root/Server/gemini-cli-proxy", // Update this path to your project location
      args: "--oauth-rotation-folder /root/Server/gemini-cli-oauth --port 3030", // Update this path to your OAuth folder
      interpreter: "none",
      env: {
        NODE_ENV: "production",
      },
      // Optional: configure restart behavior
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      // Logging
      log_file: "/var/log/gemini-proxy.log",
      error_file: "/var/log/gemini-proxy-error.log",
      out_file: "/dev/null",
      merge_logs: true,
    },
  ],
};
