import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TenantRow {
  id: number;
  slug: string;
  name: string;
  iana_timezone: string;
}

export interface AdminRow {
  id: number;
  email: string;
  tenant_id: number;
}

export interface CourseRow {
  id: number;
  title: string;
  tenant_id: number;
}

export interface LearnerRow {
  id: number;
  name: string;
  tenant_id: number;
}

export interface EnrollmentRow {
  id: number;
  learner_id: number;
  course_id: number;
  tenant_id: number;
  status: 'completed' | 'incomplete';
  completed_at: string | null;
}

export interface CertificateRow {
  id: number;
  serial_number: string;
  learner_id: number;
  course_id: number;
  tenant_id: number;
  status: 'active' | 'revoked';
  issued_at: string;
  issued_date_local: string;
  revoked_at: string | null;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  iana_timezone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id        INTEGER PRIMARY KEY,
  email     TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS learners (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS courses (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id           INTEGER PRIMARY KEY,
  learner_id   INTEGER NOT NULL REFERENCES learners(id),
  course_id    INTEGER NOT NULL REFERENCES courses(id),
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  status       TEXT NOT NULL CHECK (status IN ('completed','incomplete')),
  completed_at TEXT,
  UNIQUE (learner_id, course_id)
);

CREATE TABLE IF NOT EXISTS certificates (
  id                INTEGER PRIMARY KEY,
  serial_number     TEXT NOT NULL UNIQUE,
  learner_id        INTEGER NOT NULL,
  course_id         INTEGER NOT NULL,
  tenant_id         INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','revoked')),
  issued_at         TEXT NOT NULL,
  issued_date_local TEXT NOT NULL,
  revoked_at        TEXT,
  UNIQUE (learner_id, course_id)
);

CREATE TABLE IF NOT EXISTS certificate_audit (
  id             INTEGER PRIMARY KEY,
  certificate_id INTEGER NOT NULL REFERENCES certificates(id),
  action         TEXT NOT NULL CHECK (action IN ('issued','revoked')),
  actor_admin_id INTEGER NOT NULL,
  tenant_id      INTEGER NOT NULL,
  acted_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       TEXT NOT NULL,
  result_json  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (tenant_id, key)
);
`;

export function defaultDbPath(): string {
  const env = process.env.DB_PATH;
  if (env && env.length > 0) return env;
  return fileURLToPath(new URL('../data/certificates.db', import.meta.url));
}

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function lastId(result: { lastInsertRowid: number | bigint }): number {
  return Number(result.lastInsertRowid);
}
