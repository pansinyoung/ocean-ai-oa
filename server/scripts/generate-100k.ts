import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, openDb } from '../src/db.js';
import { utcIso } from '../src/tz.js';

const EAST_SLUG = 'east';
const EAST_TZ = 'Australia/Sydney';
const COUNT = 100_000;

interface EastTenant {
  id: number;
  slug: string;
  iana_timezone: string;
}

export function generate100k(db: DatabaseSync): { inserted: number; tenantId: number } {
  // Ensure the East tenant exists without depending on the quick-start dataset's shape.
  let east = db
    .prepare('SELECT id AS id, slug AS slug, iana_timezone AS iana_timezone FROM tenants WHERE slug = ?')
    .get(EAST_SLUG) as unknown as EastTenant | undefined;

  if (!east) {
    db.prepare('INSERT INTO tenants (slug, name, iana_timezone) VALUES (?, ?, ?)').run(EAST_SLUG, 'East', EAST_TZ);
    east = db
      .prepare('SELECT id AS id, slug AS slug, iana_timezone AS iana_timezone FROM tenants WHERE slug = ?')
      .get(EAST_SLUG) as unknown as EastTenant;
  }

  const tenantId = east.id;
  const slug = east.slug;
  const tz = east.iana_timezone || EAST_TZ;

  const maxLearner = Number(
    (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM learners').get() as unknown as { m: number }).m
  );
  const maxCert = Number(
    (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM certificates').get() as unknown as { m: number }).m
  );

  // Reuse a single formatter: constructing Intl.DateTimeFormat is expensive and this loops 100k times.
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // All instants fall on the SAME Sydney calendar day (2026-01-11), so every row shares
  // issued_date_local and equal-sort-key ordering is exercised (tiebreak by id).
  const base = Date.UTC(2026, 0, 10, 13, 0, 0); // 2026-01-11 00:00 in Australia/Sydney

  db.exec('BEGIN IMMEDIATE');
  try {
    const courseResult = db.prepare('INSERT INTO courses (title, tenant_id) VALUES (?, ?)').run('Bulk Course 100k', tenantId);
    const courseId = Number(courseResult.lastInsertRowid);

    const insertLearner = db.prepare('INSERT INTO learners (id, name, tenant_id) VALUES (?, ?, ?)');
    const insertEnrollment = db.prepare(
      'INSERT INTO enrollments (learner_id, course_id, tenant_id, status, completed_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertCert = db.prepare(
      `INSERT INTO certificates (id, serial_number, learner_id, course_id, tenant_id, status, issued_at, issued_date_local, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
    );

    const startId = maxCert + 1;
    for (let i = 0; i < COUNT; i++) {
      const learnerId = maxLearner + 1 + i;
      const certId = startId + i;
      const issuedAt = utcIso(base + i * 800); // spreads across the same local day
      const dateLocal = dateFmt.format(new Date(issuedAt));

      insertLearner.run(learnerId, `Bulk Learner ${String(i + 1).padStart(6, '0')}`, tenantId);
      insertEnrollment.run(learnerId, courseId, tenantId, 'completed', issuedAt);
      insertCert.run(
        certId,
        `CERT-${slug}-${String(certId).padStart(8, '0')}`,
        learnerId,
        courseId,
        tenantId,
        issuedAt,
        dateLocal
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { inserted: COUNT, tenantId };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const db = openDb(defaultDbPath());
  const started = Date.now();
  const { inserted } = generate100k(db);
  const elapsed = Date.now() - started;
  console.log(`Generated ${inserted} East certificates in ${elapsed}ms at ${defaultDbPath()}`);
  db.close();
}
