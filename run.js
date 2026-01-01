const { startServer } = require('./server');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;

// Start server
const server = startServer(PORT);

// After server starts, open the browser to the site (cross-platform)
function openBrowser(url) {
  const plat = process.platform;
  let cmd;
  if (plat === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (plat === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) console.error('Failed to open browser:', err.message || err);
  });
}

// Wait a moment then open browser
setTimeout(() => openBrowser(`http://localhost:${PORT}`), 300);

// graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});
