const ACTOR_STORAGE_KEY = 'certAdmin.actorId';

export function getStoredActorId(): string | null {
  try {
    return localStorage.getItem(ACTOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeActorId(id: string | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(ACTOR_STORAGE_KEY);
    } else {
      localStorage.setItem(ACTOR_STORAGE_KEY, id);
    }
  } catch {
    // Ignore storage failures (e.g. private browsing).
  }
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unexpected error';
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // fall through to a generic message
  }
  return `Request failed with status ${res.status}`;
}

interface FetchOptions {
  /** Defaults to true. Set false only for the actor list bootstrap request. */
  attachActor?: boolean;
}

async function rawFetch(
  path: string,
  init: RequestInit = {},
  opts: FetchOptions = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (opts.attachActor !== false) {
    const actorId = getStoredActorId();
    if (actorId) {
      headers.set('X-Actor-Id', actorId);
    }
  }
  return fetch(path, { ...init, headers });
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rawFetch(path, init);
  if (!res.ok) {
    throw new ApiError(res.status, await readError(res));
  }
  return (await res.json()) as T;
}

// ---- Types ----

export interface Actor {
  email: string;
  tenant: string;
}

export interface Course {
  id: number;
  title: string;
}

export interface CertificateListItem {
  id: number;
  serialNumber: string;
  learnerName: string;
  courseTitle: string;
  status: string;
  issuedDateLocal: string;
}

export interface CertificateList {
  items: CertificateListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CertificateDetail {
  id: number;
  serialNumber: string;
  learnerName: string;
  courseTitle: string;
  status: string;
  issuedAtLocal: string;
  revokedAtLocal: string | null;
}

export type OutcomeStatus = 'issued' | 'skipped' | 'failed';

export interface BulkIssueOutcome {
  learnerId: number;
  learnerName: string;
  status: OutcomeStatus;
  reason: string | null;
}

export interface BulkIssueSummary {
  issued: number;
  skipped: number;
  failed: number;
}

export interface BulkIssueResult {
  courseId: number;
  outcomes: BulkIssueOutcome[];
  summary: BulkIssueSummary;
}

export interface ListParams {
  search: string;
  sort: string;
  order: string;
  page: number;
  pageSize: number;
}

// ---- API calls ----

export async function fetchActors(): Promise<Actor[]> {
  const res = await rawFetch('/api/actors', {}, { attachActor: false });
  if (!res.ok) {
    throw new ApiError(res.status, await readError(res));
  }
  const data = (await res.json()) as { actors: Actor[] };
  return data.actors;
}

export async function fetchCourses(): Promise<Course[]> {
  const data = await apiFetch<{ courses: Course[] }>('/api/courses');
  return data.courses;
}

export async function fetchCertificates(params: ListParams): Promise<CertificateList> {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.sort) q.set('sort', params.sort);
  if (params.order) q.set('order', params.order);
  q.set('page', String(params.page));
  q.set('pageSize', String(params.pageSize));
  return apiFetch<CertificateList>(`/api/certificates?${q.toString()}`);
}

export async function fetchCertificate(id: number): Promise<CertificateDetail> {
  return apiFetch<CertificateDetail>(`/api/certificates/${id}`);
}

export async function bulkIssue(
  courseId: number,
  idempotencyKey: string,
): Promise<BulkIssueResult> {
  return apiFetch<BulkIssueResult>('/api/certificates/bulk-issue', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ courseId }),
  });
}

export async function revokeCertificate(id: number): Promise<{ id: number; status: string }> {
  return apiFetch<{ id: number; status: string }>(`/api/certificates/${id}/revoke`, {
    method: 'POST',
  });
}

export async function exportCsv(search: string, sort: string, order: string): Promise<void> {
  const q = new URLSearchParams();
  if (search) q.set('search', search);
  if (sort) q.set('sort', sort);
  if (order) q.set('order', order);
  const qs = q.toString();
  const path = `/api/export/certificates.csv${qs ? `?${qs}` : ''}`;

  const res = await rawFetch(path);
  if (!res.ok) {
    throw new ApiError(res.status, await readError(res));
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'certificates.csv';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
