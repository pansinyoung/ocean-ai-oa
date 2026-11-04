import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDbPath, openDb } from './db.js';
import { createApp } from './app.js';
import { seedDatabase } from './seed.js';

const db = openDb(defaultDbPath());

const tenantCount = (db.prepare('SELECT COUNT(*) AS c FROM tenants').get() as unknown as { c: number }).c;
if (tenantCount === 0) {
  seedDatabase(db);
}

const app = createApp(db);

// Serve the built frontend if it exists (static + SPA fallback for non-/api GETs).
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(path.join(webDist, 'index.html'));
      return;
    }
    next();
  });
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Certificate Admin Console listening on http://localhost:${port}`);
});
