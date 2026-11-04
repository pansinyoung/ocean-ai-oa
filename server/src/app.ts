import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { toLocalDate, toLocalDateTime, nowUtcIso } from './tz.js';
import type { AdminRow, TenantRow } from './db.js';

type SQLValue = string | number | null;

const SORT_KEYS = ['learnerName', 'serial', 'courseTitle', 'issueDate'] as const;
type SortKey = (typeof SORT_KEYS)[number];

const SORT_COLUMNS: Record<SortKey, string> = {
  learnerName: 'l.name',
  serial: 'c.serial_number',
  courseTitle: 'co.title',
  issueDate: 'c.issued_date_local',
};

const CERT_SELECT = `
SELECT c.id AS id,
       c.serial_number AS serial_number,
       l.name AS learner_name,
       co.title AS course_title,
       c.status AS status,
       c.issued_date_local AS issued_date_local,
       c.issued_at AS issued_at,
       c.revoked_at AS revoked_at
FROM certificates c
JOIN learners l ON l.id = c.learner_id
JOIN courses co ON co.id = c.course_id
`;

interface CertRow {
  id: number;
  serial_number: string;
  learner_name: string;
  course_title: string;
  status: 'active' | 'revoked';
  issued_date_local: string;
  issued_at: string;
  revoked_at: string | null;
}

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n)) return fallback;
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

function parseSort(raw: unknown): SortKey {
  if (typeof raw === 'string' && (SORT_KEYS as readonly string[]).includes(raw)) {
    return raw as SortKey;
  }
  return 'issueDate';
}

function parseOrder(raw: unknown): 'asc' | 'desc' {
  return raw === 'asc' ? 'asc' : 'desc';
}

function buildFilter(tenantId: number, search: string): { where: string; params: SQLValue[] } {
  if (search) {
    return {
      where: `WHERE c.tenant_id = ? AND (instr(lower(l.name), lower(?)) > 0 OR instr(lower(c.serial_number), lower(?)) > 0)`,
      params: [tenantId, search, search],
    };
  }
  return { where: 'WHERE c.tenant_id = ?', params: [tenantId] };
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function createApp(db: DatabaseSync): express.Express {
  const app = express();
  app.use(express.json());

  const tenantOf = (res: Response): TenantRow => res.locals.tenant as TenantRow;
  const adminOf = (res: Response): AdminRow => res.locals.admin as AdminRow;

  // D3: shared actor resolution middleware. /api/actors is mounted before this.
  const resolveActor = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('X-Actor-Id');
    if (!header || header.trim() === '') {
      res.status(401).json({ error: 'X-Actor-Id header required' });
      return;
    }
    const row = db
      .prepare(
        `SELECT a.id AS id, a.email AS email, a.tenant_id AS tenant_id,
                t.slug AS slug, t.name AS name, t.iana_timezone AS iana_timezone
         FROM admins a JOIN tenants t ON t.id = a.tenant_id
         WHERE a.email = ?`
      )
      .get(header.trim()) as unknown as (AdminRow & TenantRow) | undefined;

    if (!row) {
      res.status(401).json({ error: 'Unknown actor' });
      return;
    }
    res.locals.admin = {
      id: row.id,
      email: row.email,
      tenant_id: row.tenant_id,
    } satisfies AdminRow;
    res.locals.tenant = {
      id: row.tenant_id,
      slug: row.slug,
      name: row.name,
      iana_timezone: row.iana_timezone,
    } satisfies TenantRow;
    next();
  };

  // ---- GET /api/actors (no actor header required: it powers the actor switcher) ----
  app.get('/api/actors', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT a.email AS email, t.name AS tenant
         FROM admins a JOIN tenants t ON t.id = a.tenant_id
         ORDER BY a.id ASC`
      )
      .all() as unknown as { email: string; tenant: string }[];
    res.json({ actors: rows });
  });

  // Everything below requires a resolved actor.
  app.use(['/api/courses', '/api/certificates', '/api/export'], resolveActor);

  // ---- GET /api/courses ----
  app.get('/api/courses', (_req, res) => {
    const tenant = tenantOf(res);
    const rows = db
      .prepare('SELECT id AS id, title AS title FROM courses WHERE tenant_id = ? ORDER BY id ASC')
      .all(tenant.id) as unknown as { id: number; title: string }[];
    res.json({ courses: rows });
  });

  // ---- GET /api/certificates (list) ----
  app.get('/api/certificates', (req, res) => {
    const tenant = tenantOf(res);
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const sort = parseSort(req.query.sort);
    const order = parseOrder(req.query.order);
    const page = parsePositiveInt(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);

    const filter = buildFilter(tenant.id, search);
    const orderBy = `ORDER BY ${SORT_COLUMNS[sort]} ${order === 'asc' ? 'ASC' : 'DESC'}, c.id ${order === 'asc' ? 'ASC' : 'DESC'}`;

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS total FROM certificates c JOIN learners l ON l.id = c.learner_id JOIN courses co ON co.id = c.course_id ${filter.where}`)
      .get(...filter.params) as unknown as { total: number };
    const total = totalRow.total;

    const rows = db
      .prepare(`${CERT_SELECT} ${filter.where} ${orderBy} LIMIT ? OFFSET ?`)
      .all(...filter.params, pageSize, (page - 1) * pageSize) as unknown as CertRow[];

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        serialNumber: r.serial_number,
        learnerName: r.learner_name,
        courseTitle: r.course_title,
        status: r.status,
        issuedDateLocal: r.issued_date_local,
      })),
      total,
      page,
      pageSize,
    });
  });

  // ---- POST /api/certificates/bulk-issue ----
  app.post('/api/certificates/bulk-issue', (req, res) => {
    const tenant = tenantOf(res);
    const admin = adminOf(res);

    const keyHeader = req.get('Idempotency-Key');
    if (!keyHeader || keyHeader.trim() === '') {
      res.status(400).json({ error: 'Idempotency-Key header required' });
      return;
    }
    const key = keyHeader.trim();

    const body = (req.body ?? {}) as { courseId?: unknown };
    const courseId = typeof body.courseId === 'number' ? body.courseId : Number(body.courseId);
    if (!Number.isInteger(courseId) || courseId <= 0) {
      res.status(400).json({ error: 'courseId must be a positive integer' });
      return;
    }

    // Verify the course belongs to the actor's tenant BEFORE any write (zero writes on 404).
    const course = db
      .prepare('SELECT id AS id FROM courses WHERE id = ? AND tenant_id = ?')
      .get(courseId, tenant.id) as unknown as { id: number } | undefined;
    if (!course) {
      res.status(404).json({ error: 'Course not found' });
      return;
    }

    const requestHash = createHash('sha256').update(JSON.stringify({ courseId })).digest('hex');

    const result = runBulkIssue(db, tenant, admin, courseId, key, requestHash);
    if (result.kind === 'conflict') {
      res.status(409).json({ error: 'Idempotency-Key already used with a different payload' });
      return;
    }
    res.json(result.body);
  });

  // ---- GET /api/certificates/:id ----
  app.get('/api/certificates/:id', (req, res) => {
    const tenant = tenantOf(res);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const row = db
      .prepare(`${CERT_SELECT} WHERE c.id = ? AND c.tenant_id = ?`)
      .get(id, tenant.id) as unknown as CertRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({
      id: row.id,
      serialNumber: row.serial_number,
      learnerName: row.learner_name,
      courseTitle: row.course_title,
      status: row.status,
      issuedAtLocal: toLocalDateTime(row.issued_at, tenant.iana_timezone),
      revokedAtLocal: row.revoked_at ? toLocalDateTime(row.revoked_at, tenant.iana_timezone) : null,
    });
  });

  // ---- POST /api/certificates/:id/revoke ----
  app.post('/api/certificates/:id/revoke', (req, res) => {
    const tenant = tenantOf(res);
    const admin = adminOf(res);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const cert = db
      .prepare('SELECT id AS id, status AS status FROM certificates WHERE id = ? AND tenant_id = ?')
      .get(id, tenant.id) as unknown as { id: number; status: 'active' | 'revoked' } | undefined;
    if (!cert) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (cert.status === 'revoked') {
      // Idempotent: already revoked → 200, no new audit row.
      res.json({ id: cert.id, status: 'revoked' });
      return;
    }

    const actedAt = nowUtcIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE certificates SET status = ?, revoked_at = ? WHERE id = ?').run('revoked', actedAt, cert.id);
      db.prepare(
        'INSERT INTO certificate_audit (certificate_id, action, actor_admin_id, tenant_id, acted_at) VALUES (?, ?, ?, ?, ?)'
      ).run(cert.id, 'revoked', admin.id, tenant.id, actedAt);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.json({ id: cert.id, status: 'revoked' });
  });

  // ---- GET /api/export/certificates.csv (streamed) ----
  app.get('/api/export/certificates.csv', async (req, res) => {
    const tenant = tenantOf(res);
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const sort = parseSort(req.query.sort);
    const order = parseOrder(req.query.order);

    const filter = buildFilter(tenant.id, search);
    const orderBy = `ORDER BY ${SORT_COLUMNS[sort]} ${order === 'asc' ? 'ASC' : 'DESC'}, c.id ${order === 'asc' ? 'ASC' : 'DESC'}`;
    const sql = `${CERT_SELECT} ${filter.where} ${orderBy}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="certificates.csv"');
    res.write('learner_name,course_title,serial_number,issue_date\n');

    const iterator = db.prepare(sql).iterate(...filter.params);

    const BATCH_SIZE = 1000;
    const drain = (): Promise<void> => new Promise((resolve) => res.once('drain', resolve));

    let buffer = '';
    for (const raw of iterator) {
      const row = raw as unknown as CertRow;
      buffer +=
        csvField(row.learner_name) +
        ',' +
        csvField(row.course_title) +
        ',' +
        csvField(row.serial_number) +
        ',' +
        csvField(row.issued_date_local) +
        '\n';

      if (buffer.length >= 64 * 1024) {
        if (!res.write(buffer)) {
          await drain();
        }
        buffer = '';
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (buffer.length > 0) {
      res.write(buffer);
    }
    res.end();
  });

  // ---- 404 for unmatched API routes ----
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ---- JSON body parse / general error handler ----
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number } | null)?.status;
    if (status === 400) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

interface BulkResult {
  kind: 'ok' | 'conflict';
  body?: {
    courseId: number;
    outcomes: Array<{
      learnerId: number;
      learnerName: string;
      status: 'issued' | 'skipped' | 'failed';
      reason: string | null;
    }>;
    summary: { issued: number; skipped: number; failed: number };
  };
}

function runBulkIssue(
  db: DatabaseSync,
  tenant: TenantRow,
  admin: AdminRow,
  courseId: number,
  key: string,
  requestHash: string
): BulkResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db
      .prepare('SELECT request_hash AS request_hash, result_json AS result_json FROM idempotency_keys WHERE tenant_id = ? AND key = ?')
      .get(tenant.id, key) as unknown as { request_hash: string; result_json: string | null } | undefined;

    if (existing) {
      if (existing.request_hash === requestHash) {
        db.exec('COMMIT');
        const body = existing.result_json ? (JSON.parse(existing.result_json) as NonNullable<BulkResult['body']>) : undefined;
        return body ? { kind: 'ok', body } : { kind: 'conflict' };
      }
      db.exec('ROLLBACK');
      return { kind: 'conflict' };
    }

    // Load enrollments for the course, ordered deterministically by learner id.
    const enrollments = db
      .prepare(
        `SELECT e.learner_id AS learner_id, l.name AS learner_name, e.status AS status
         FROM enrollments e
         JOIN learners l ON l.id = e.learner_id
         WHERE e.course_id = ? AND e.tenant_id = ?
         ORDER BY e.learner_id ASC`
      )
      .all(courseId, tenant.id) as unknown as {
      learner_id: number;
      learner_name: string;
      status: 'completed' | 'incomplete';
    }[];

    const hasActiveCert = db.prepare(
      `SELECT id AS id FROM certificates WHERE learner_id = ? AND course_id = ? AND tenant_id = ? AND status = 'active' LIMIT 1`
    );

    const insertCert = db.prepare(
      `INSERT INTO certificates (id, serial_number, learner_id, course_id, tenant_id, status, issued_at, issued_date_local, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
    );
    const insertAudit = db.prepare(
      `INSERT INTO certificate_audit (certificate_id, action, actor_admin_id, tenant_id, acted_at) VALUES (?, 'issued', ?, ?, ?)`
    );

    let nextId = Number(
      (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM certificates').get() as unknown as { m: number }).m
    ) + 1;

    const outcomes: NonNullable<BulkResult['body']>['outcomes'] = [];
    let issued = 0;
    let skipped = 0;
    let failed = 0;

    for (const e of enrollments) {
      if (e.status !== 'completed') {
        outcomes.push({ learnerId: e.learner_id, learnerName: e.learner_name, status: 'skipped', reason: 'not-completed' });
        skipped += 1;
        continue;
      }

      const active = hasActiveCert.get(e.learner_id, courseId, tenant.id);
      if (active) {
        outcomes.push({ learnerId: e.learner_id, learnerName: e.learner_name, status: 'skipped', reason: 'already-certified' });
        skipped += 1;
        continue;
      }

      try {
        const issuedAt = nowUtcIso();
        const issuedDateLocal = toLocalDate(issuedAt, tenant.iana_timezone);
        const serial = `CERT-${tenant.slug}-${String(nextId).padStart(8, '0')}`;
        insertCert.run(nextId, serial, e.learner_id, courseId, tenant.id, issuedAt, issuedDateLocal);
        insertAudit.run(nextId, admin.id, tenant.id, issuedAt);
        nextId += 1;
        issued += 1;
        outcomes.push({ learnerId: e.learner_id, learnerName: e.learner_name, status: 'issued', reason: null });
      } catch (err) {
        failed += 1;
        outcomes.push({
          learnerId: e.learner_id,
          learnerName: e.learner_name,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const body = {
      courseId,
      outcomes,
      summary: { issued, skipped, failed },
    };

    db.prepare(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status, result_json, created_at) VALUES (?, ?, ?, 'completed', ?, ?)`
    ).run(tenant.id, key, requestHash, JSON.stringify(body), nowUtcIso());

    db.exec('COMMIT');
    return { kind: 'ok', body };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // transaction may already be closed
    }
    throw err;
  }
}
