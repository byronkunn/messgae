import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { purgeExpiredTrash, collectOrphanBlobs } from './lib/files.js';

const { app, ctx, attachRealtime, close } = createApp();
const server = http.createServer(app);
attachRealtime(server);

// Housekeeping: purge expired trash, orphaned blobs and stale tickets.
const housekeeping = setInterval(() => {
  try {
    purgeExpiredTrash(ctx);
    collectOrphanBlobs(ctx);
    ctx.db.run('DELETE FROM download_tickets WHERE expires_at < ?', Date.now());
    ctx.db.run('DELETE FROM device_links WHERE expires_at < ?', Date.now() - 3600_000);
  } catch (err) {
    console.error('housekeeping failed', err);
  }
}, 15 * 60_000);
housekeeping.unref();

server.listen(config.port, config.host, () => {
  console.log(`messgae server listening on http://${config.host}:${config.port} (${config.isProd ? 'production' : 'development'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    close();
    process.exit(0);
  });
}
