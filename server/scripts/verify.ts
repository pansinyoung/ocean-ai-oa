import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedDatabase } from '../src/seed.js';
import { generate100k } from './generate-100k.js';

const ALICE = 'alice@east.test';
const BOB = 'bob@west.test';

interface Resp {
  status: number;
  json: any;
  text: string;
}

async function request(method: string, urlPath: string, opts: { actor?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Resp> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.actor) headers['X-Actor-Id'] = opts.actor;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(urlPath, init);
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON response
  }
  return { status: res.status, json, text };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((db.prepare(sql).get(...params) as unknown as { c: number }).c);
}

async function main(): Promise<void> {
  // Use DB_PATH if provided (e.g. for debugging), otherwise a throwaway temp file.
  const envPath = process.env.DB_PATH;
  const tempDir = envPath ? null : mkdtempSync(path.join(tmpdir(), 'cert-verify-'));
  const dbPath = envPath || path.join(tempDir!, 'certificates.db');

  const db = openDb(dbPath);
  seedDatabase(db);
  generate100k(db);

  const app = createApp(db);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  let checks = 0;
  let failures = 0;
  const check = (label: string, ok: boolean, detail?: string): void => {
    checks += 1;
    if (ok) {
      console.log(`    PASS ${label}`);
    } else {
      failures += 1;
      console.log(`    FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
  };

  try {
    const east = db.prepare("SELECT id AS id FROM tenants WHERE slug = 'east'").get() as unknown as { id: number };
    const west = db.prepare("SELECT id AS id FROM tenants WHERE slug = 'west'").get() as unknown as { id: number };
    const eastCourse = db.prepare("SELECT id AS id FROM courses WHERE tenant_id = ? AND title = 'Safety 101' LIMIT 1").get(east.id) as unknown as { id: number };
    const westCourse = db.prepare("SELECT id AS id FROM courses WHERE tenant_id = ? AND title = 'Safety 101' LIMIT 1").get(west.id) as unknown as { id: number };

    const countCerts = () => count(db, 'SELECT COUNT(*) AS c FROM certificates');
    const countAudit = () => count(db, 'SELECT COUNT(*) AS c FROM certificate_audit');
    const countTenantCerts = (tenantId: number) => count(db, 'SELECT COUNT(*) AS c FROM certificates WHERE tenant_id = ?', tenantId);
    const countTenantAudit = (tenantId: number) => count(db, 'SELECT COUNT(*) AS c FROM certificate_audit WHERE tenant_id = ?', tenantId);

    // ---------------------------------------------------------------- A1
    console.log('A1 Tenant isolation (Bob must not see East data)');
    {
      const list = await request('GET', `${base}/api/certificates?pageSize=100`, { actor: BOB });
      check('Bob list returns 200', list.status === 200);
      check(
        'Bob list total equals West cert count (not East 100k)',
        list.json?.total === countTenantCerts(west.id),
        `total=${list.json?.total} expected=${countTenantCerts(west.id)}`
      );
      const westOnly = (list.json?.items ?? []).every((it: any) => typeof it.serialNumber === 'string' && it.serialNumber.startsWith('CERT-west-'));
      check('Bob list items are all West serials', westOnly);

      const eastCertId = (db.prepare('SELECT id AS id FROM certificates WHERE tenant_id = ? LIMIT 1').get(east.id) as unknown as { id: number }).id;
      const detail = await request('GET', `${base}/api/certificates/${eastCertId}`, { actor: BOB });
      check('Bob cross-tenant detail → 404', detail.status === 404, `got ${detail.status}`);

      const certsBefore = countCerts();
      const auditBefore = countAudit();
      const bulk = await request('POST', `${base}/api/certificates/bulk-issue`, {
        actor: BOB,
        body: { courseId: eastCourse.id },
        headers: { 'Idempotency-Key': 'verify-a1-key' },
      });
      check('Bob cross-tenant bulk-issue → 404', bulk.status === 404, `got ${bulk.status}`);
      check('Bob cross-tenant bulk-issue wrote no certificates', countCerts() === certsBefore);
      check('Bob cross-tenant bulk-issue wrote no audit rows', countAudit() === auditBefore);

      const exp = await request('GET', `${base}/api/export/certificates.csv`, { actor: BOB });
      check('Bob export returns 200', exp.status === 200);
      check('Bob export contains no East serials', !exp.text.includes('CERT-east-'));
      check('Bob export contains West rows', exp.text.includes('CERT-west-'));
    }

    // ---------------------------------------------------------------- A5
    console.log('A5 DST & tenant-local date');
    {
      const eCert = db.prepare("SELECT id AS id FROM certificates WHERE serial_number = 'CERT-east-00000001'").get() as unknown as { id: number };
      const wCert = db.prepare("SELECT id AS id FROM certificates WHERE serial_number = 'CERT-west-00000001'").get() as unknown as { id: number };

      const eDetail = await request('GET', `${base}/api/certificates/${eCert.id}`, { actor: ALICE });
      check('East fixture detail → 200', eDetail.status === 200);
      check('East issuedAtLocal = 2026-01-11 00:30', eDetail.json?.issuedAtLocal === '2026-01-11 00:30', `got ${eDetail.json?.issuedAtLocal}`);

      const wDetail = await request('GET', `${base}/api/certificates/${wCert.id}`, { actor: BOB });
      check('West fixture detail → 200', wDetail.status === 200);
      check('West issuedAtLocal = 2026-01-10 21:30', wDetail.json?.issuedAtLocal === '2026-01-10 21:30', `got ${wDetail.json?.issuedAtLocal}`);

      const eDate = (db.prepare("SELECT issued_date_local AS d FROM certificates WHERE serial_number = 'CERT-east-00000001'").get() as unknown as { d: string }).d;
      const wDate = (db.prepare("SELECT issued_date_local AS d FROM certificates WHERE serial_number = 'CERT-west-00000001'").get() as unknown as { d: string }).d;
      check('East issued_date_local = 2026-01-11', eDate === '2026-01-11', `got ${eDate}`);
      check('West issued_date_local = 2026-01-10', wDate === '2026-01-10', `got ${wDate}`);
    }

    // ---------------------------------------------------------------- A4
    console.log('A4 Learner outcomes (West bulk-issue)');
    {
      const res = await request('POST', `${base}/api/certificates/bulk-issue`, {
        actor: BOB,
        body: { courseId: westCourse.id },
        headers: { 'Idempotency-Key': 'verify-a4-key' },
      });
      check('bulk-issue returns 200', res.status === 200, `got ${res.status}`);

      const outcomes: any[] = res.json?.outcomes ?? [];
      const byName = new Map<string, any>(outcomes.map((o) => [o.learnerName, o]));

      check('Sam Rivera → issued', byName.get('Sam Rivera')?.status === 'issued', JSON.stringify(byName.get('Sam Rivera')));
      check('Casey Chen → issued', byName.get('Casey Chen')?.status === 'issued');
      check('Jordan Kim → skipped not-completed', byName.get('Jordan Kim')?.status === 'skipped' && byName.get('Jordan Kim')?.reason === 'not-completed');
      check('Riley Patel → skipped not-completed', byName.get('Riley Patel')?.status === 'skipped' && byName.get('Riley Patel')?.reason === 'not-completed');
      check('Alex Lee → skipped already-certified', byName.get('Alex Lee')?.status === 'skipped' && byName.get('Alex Lee')?.reason === 'already-certified');

      check(
        'summary issued=2 skipped=3 failed=0',
        res.json?.summary?.issued === 2 && res.json?.summary?.skipped === 3 && res.json?.summary?.failed === 0,
        JSON.stringify(res.json?.summary)
      );
      check('no failed outcomes', outcomes.every((o) => o.status !== 'failed'));
      check('issued outcomes have reason null', outcomes.filter((o) => o.status === 'issued').every((o) => o.reason === null));
      check(
        'skipped reasons are exactly not-completed/already-certified',
        outcomes.filter((o) => o.status === 'skipped').every((o) => o.reason === 'not-completed' || o.reason === 'already-certified')
      );
    }

    // ---------------------------------------------------------------- A2
    console.log('A2 Retry safety (N concurrent identical requests, same key)');
    {
      const eligibleSql = `
        SELECT COUNT(*) AS c FROM enrollments e
        WHERE e.course_id = ? AND e.tenant_id = ? AND e.status = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM certificates c
            WHERE c.learner_id = e.learner_id AND c.course_id = e.course_id
              AND c.tenant_id = e.tenant_id AND c.status = 'active'
          )
      `;
      const expected = count(db, eligibleSql, eastCourse.id, east.id);

      const certsBefore = countTenantCerts(east.id);
      const auditBefore = countTenantAudit(east.id);

      const key = 'verify-a2-concurrent-key';
      const N = 12;
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          request('POST', `${base}/api/certificates/bulk-issue`, {
            actor: ALICE,
            body: { courseId: eastCourse.id },
            headers: { 'Idempotency-Key': key },
          })
        )
      );
      check('all N concurrent requests return 200', responses.every((r) => r.status === 200), responses.map((r) => r.status).join(','));

      const bodies = responses.map((r) => JSON.stringify(r.json));
      check('all callers receive identical outcome', bodies.every((b) => b === bodies[0]));

      check(
        'exactly one logical issuance (cert delta = eligible count)',
        countTenantCerts(east.id) - certsBefore === expected,
        `delta=${countTenantCerts(east.id) - certsBefore} expected=${expected}`
      );
      check(
        'exactly one issued audit per issuance',
        countTenantAudit(east.id) - auditBefore === expected,
        `delta=${countTenantAudit(east.id) - auditBefore} expected=${expected}`
      );
    }

    // ---------------------------------------------------------------- A3
    console.log('A3 Idempotency key misuse');
    {
      const bulkCourse = db.prepare("SELECT id AS id FROM courses WHERE tenant_id = ? AND title = 'Bulk Course 100k' LIMIT 1").get(east.id) as unknown as { id: number };
      const certsBefore = countTenantCerts(east.id);

      const misuse = await request('POST', `${base}/api/certificates/bulk-issue`, {
        actor: ALICE,
        body: { courseId: bulkCourse.id },
        headers: { 'Idempotency-Key': 'verify-a2-concurrent-key' },
      });
      check('reusing key with different payload → 409', misuse.status === 409, `got ${misuse.status}`);
      check('409 wrote no certificates', countTenantCerts(east.id) === certsBefore);

      const replay = await request('POST', `${base}/api/certificates/bulk-issue`, {
        actor: ALICE,
        body: { courseId: eastCourse.id },
        headers: { 'Idempotency-Key': 'verify-a2-concurrent-key' },
      });
      check('original key still replays original result', replay.status === 200 && replay.json?.summary?.issued === 2, JSON.stringify(replay.json?.summary));
    }

    // ---------------------------------------------------------------- A6
    console.log('A6 Export streaming, determinism, and responsiveness');
    {
      const eastCount = countTenantCerts(east.id);
      const exportUrl = `${base}/api/export/certificates.csv?sort=issueDate&order=desc`;

      const t0 = Date.now();
      const exp1 = (await request('GET', exportUrl, { actor: ALICE })).text;
      const dur1 = Date.now() - t0;

      const lines = exp1.split('\n').filter((l) => l.length > 0);
      check('export header row correct', lines[0] === 'learner_name,course_title,serial_number,issue_date', lines[0]);
      const rowCount = lines.length - 1;
      check('export row count matches East cert count', rowCount === eastCount, `rows=${rowCount} expected=${eastCount}`);
      check('export duration < 60s', dur1 < 60_000, `${dur1}ms`);

      // Deterministic total order: issue_date must be non-increasing (desc).
      const dates = lines.slice(1).map((l) => l.split(',').slice(-1)[0]);
      let monotonic = true;
      for (let i = 1; i < dates.length; i++) {
        if (dates[i] > dates[i - 1]) {
          monotonic = false;
          break;
        }
      }
      check('export sorted by issue_date desc (non-increasing)', monotonic);

      const exp2 = (await request('GET', exportUrl, { actor: ALICE })).text;
      check('two exports byte-identical', exp1 === exp2);

      // A6 also requires applying a SEARCH, not just a sort. A unique serial
      // must filter the export to exactly one matching row, deterministically.
      const searchUrl = `${base}/api/export/certificates.csv?search=CERT-east-00000003&sort=issueDate&order=desc`;
      const s1 = (await request('GET', searchUrl, { actor: ALICE })).text;
      const s2 = (await request('GET', searchUrl, { actor: ALICE })).text;
      const sLines = s1.split('\n').filter((l) => l.length > 0);
      check(
        'export search filters to matching rows',
        sLines.length - 1 === 1 && sLines[1].includes('CERT-east-00000003'),
        JSON.stringify(sLines)
      );
      check('search-filtered export is deterministic', s1 === s2);

      // Hit the list endpoint while an export is running.
      const expPromise = request('GET', exportUrl, { actor: ALICE });
      await sleep(80);
      const listMid = await request('GET', `${base}/api/certificates?page=1&pageSize=5`, { actor: ALICE });
      check('list request succeeds during export', listMid.status === 200 && Array.isArray(listMid.json?.items), `status=${listMid.status}`);
      await expPromise;
    }

    // ---------------------------------------------------------------- A7
    console.log('A7 Revocation audit (one event; repeat writes none)');
    {
      const cert = db.prepare("SELECT id AS id FROM certificates WHERE tenant_id = ? AND status = 'active' ORDER BY id ASC LIMIT 1").get(east.id) as unknown as { id: number };
      const auditBefore = count(db, 'SELECT COUNT(*) AS c FROM certificate_audit WHERE certificate_id = ?', cert.id);

      const first = await request('POST', `${base}/api/certificates/${cert.id}/revoke`, { actor: ALICE });
      check('revoke returns 200', first.status === 200);
      check('revoke response status = revoked', first.json?.status === 'revoked' && first.json?.id === cert.id);
      const statusAfter = (db.prepare('SELECT status AS s FROM certificates WHERE id = ?').get(cert.id) as unknown as { s: string }).s;
      check('certificate now revoked', statusAfter === 'revoked');
      check(
        'revoke wrote exactly one audit event',
        count(db, 'SELECT COUNT(*) AS c FROM certificate_audit WHERE certificate_id = ?', cert.id) - auditBefore === 1
      );

      const second = await request('POST', `${base}/api/certificates/${cert.id}/revoke`, { actor: ALICE });
      check('repeat revoke returns 200', second.status === 200 && second.json?.status === 'revoked');
      check(
        'repeat revoke adds no audit event',
        count(db, 'SELECT COUNT(*) AS c FROM certificate_audit WHERE certificate_id = ?', cert.id) - auditBefore === 1
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('');
  console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed, ${failures} failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('verify.ts crashed:', err);
  process.exitCode = 1;
});
