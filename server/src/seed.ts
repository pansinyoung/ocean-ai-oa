import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA, defaultDbPath, openDb } from './db.js';
import { toLocalDate, nowUtcIso } from './tz.js';

const FIXTURE_ISSUED_AT = '2026-01-10T13:30:00.000Z';

export function seedDatabase(db: DatabaseSync): void {
  // Drop in reverse dependency order, then recreate from the canonical schema.
  db.exec(`
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS certificate_audit;
    DROP TABLE IF EXISTS certificates;
    DROP TABLE IF EXISTS enrollments;
    DROP TABLE IF EXISTS courses;
    DROP TABLE IF EXISTS learners;
    DROP TABLE IF EXISTS admins;
    DROP TABLE IF EXISTS tenants;
  `);
  db.exec(SCHEMA);

  db.exec('BEGIN IMMEDIATE');
  try {
    // Tenants
    db.prepare('INSERT INTO tenants (id, slug, name, iana_timezone) VALUES (?, ?, ?, ?)').run(
      1,
      'east',
      'East',
      'Australia/Sydney'
    );
    db.prepare('INSERT INTO tenants (id, slug, name, iana_timezone) VALUES (?, ?, ?, ?)').run(
      2,
      'west',
      'West',
      'Australia/Perth'
    );

    // Admins
    db.prepare('INSERT INTO admins (id, email, tenant_id) VALUES (?, ?, ?)').run(1, 'alice@east.test', 1);
    db.prepare('INSERT INTO admins (id, email, tenant_id) VALUES (?, ?, ?)').run(2, 'bob@west.test', 2);

    // Courses — one Safety 101 per tenant
    db.prepare('INSERT INTO courses (id, title, tenant_id) VALUES (?, ?, ?)').run(1, 'Safety 101', 1);
    db.prepare('INSERT INTO courses (id, title, tenant_id) VALUES (?, ?, ?)').run(2, 'Safety 101', 2);

    // Learners — the same roster in each tenant
    const learners: Array<{ id: number; name: string; tenantId: number }> = [
      { id: 1, name: 'Alex Lee', tenantId: 1 },
      { id: 2, name: 'Sam Rivera', tenantId: 1 },
      { id: 3, name: 'Jordan Kim', tenantId: 1 },
      { id: 4, name: 'Casey Chen', tenantId: 1 },
      { id: 5, name: 'Riley Patel', tenantId: 1 },
      { id: 6, name: 'Alex Lee', tenantId: 2 },
      { id: 7, name: 'Sam Rivera', tenantId: 2 },
      { id: 8, name: 'Jordan Kim', tenantId: 2 },
      { id: 9, name: 'Casey Chen', tenantId: 2 },
      { id: 10, name: 'Riley Patel', tenantId: 2 },
    ];
    const insertLearner = db.prepare('INSERT INTO learners (id, name, tenant_id) VALUES (?, ?, ?)');
    for (const l of learners) insertLearner.run(l.id, l.name, l.tenantId);

    // Enrollments on each tenant's Safety 101.
    // Alex Lee → completed + already certified; Sam/Casey → completed (eligible);
    // Jordan/Riley → incomplete.
    const enrollments: Array<{
      learnerId: number;
      courseId: number;
      tenantId: number;
      status: 'completed' | 'incomplete';
      completedAt: string | null;
    }> = [
      { learnerId: 1, courseId: 1, tenantId: 1, status: 'completed', completedAt: '2026-01-10T12:00:00.000Z' },
      { learnerId: 2, courseId: 1, tenantId: 1, status: 'completed', completedAt: '2026-01-10T12:00:00.000Z' },
      { learnerId: 3, courseId: 1, tenantId: 1, status: 'incomplete', completedAt: null },
      { learnerId: 4, courseId: 1, tenantId: 1, status: 'completed', completedAt: '2026-01-10T12:00:00.000Z' },
      { learnerId: 5, courseId: 1, tenantId: 1, status: 'incomplete', completedAt: null },
      { learnerId: 6, courseId: 2, tenantId: 2, status: 'completed', completedAt: '2026-01-10T12:00:00.000Z' },
      { learnerId: 7, courseId: 2, tenantId: 2, status: 'completed', completedAt: '2026-01-10T12:00:00.000Z' },
      { learnerId: 8, courseId: 2, tenantId: 2, status: 'incomplete', completedAt: null },
      { learnerId: 9, courseId: 2, tenantId: 2, status: 'completed', completedAt: '2026-01-10T12:00:00.000Z' },
      { learnerId: 10, courseId: 2, tenantId: 2, status: 'incomplete', completedAt: null },
    ];
    const insertEnrollment = db.prepare(
      'INSERT INTO enrollments (learner_id, course_id, tenant_id, status, completed_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const e of enrollments) insertEnrollment.run(e.learnerId, e.courseId, e.tenantId, e.status, e.completedAt);

    // A5 fixtures: Alex Lee already holds an active certificate issued at 2026-01-10T13:30:00.000Z
    // in each tenant, so both timezone derivations are exercised.
    const eastDate = toLocalDate(FIXTURE_ISSUED_AT, 'Australia/Sydney'); // 2026-01-11
    const westDate = toLocalDate(FIXTURE_ISSUED_AT, 'Australia/Perth'); // 2026-01-10

    db.prepare(
      `INSERT INTO certificates (id, serial_number, learner_id, course_id, tenant_id, status, issued_at, issued_date_local, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
    ).run(1, 'CERT-east-00000001', 1, 1, 1, FIXTURE_ISSUED_AT, eastDate);
    db.prepare(
      `INSERT INTO certificates (id, serial_number, learner_id, course_id, tenant_id, status, issued_at, issued_date_local, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
    ).run(2, 'CERT-west-00000001', 6, 2, 2, FIXTURE_ISSUED_AT, westDate);

    const insertAudit = db.prepare(
      'INSERT INTO certificate_audit (certificate_id, action, actor_admin_id, tenant_id, acted_at) VALUES (?, ?, ?, ?, ?)'
    );
    insertAudit.run(1, 'issued', 1, 1, FIXTURE_ISSUED_AT);
    insertAudit.run(2, 'issued', 2, 2, FIXTURE_ISSUED_AT);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Run directly only when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const db = openDb(defaultDbPath());
  seedDatabase(db);
  const tenantCount = (db.prepare('SELECT COUNT(*) AS c FROM tenants').get() as unknown as { c: number }).c;
  const certCount = (db.prepare('SELECT COUNT(*) AS c FROM certificates').get() as unknown as { c: number }).c;
  console.log(
    `Seeded ${tenantCount} tenants, ${certCount} certificates at ${defaultDbPath()} (${nowUtcIso()})`
  );
  db.close();
}
