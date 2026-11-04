import { useEffect, useState } from 'react';
import {
  CertificateListItem,
  errorMessage,
  exportCsv,
  fetchCertificates,
} from '../api';

interface Props {
  actorId: string;
  refreshToken: number;
  onSelectCertificate: (id: number) => void;
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'issueDate', label: 'Issue date' },
  { value: 'learnerName', label: 'Learner name' },
  { value: 'serial', label: 'Serial number' },
  { value: 'courseTitle', label: 'Course' },
];

export function CertificateList({ actorId, refreshToken, onSelectCertificate }: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('issueDate');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [items, setItems] = useState<CertificateListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Debounce the search input before it hits the list query.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!actorId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCertificates({ search, sort, order, page, pageSize })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setTotal(data.total);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actorId, refreshToken, retryToken, search, sort, order, page, pageSize]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportCsv(search, sort, order);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="certificate-list">
      <div className="list-header">
        <h2>Certificates</h2>
        <button className="btn" onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      <div className="controls">
        <input
          type="search"
          className="search-input"
          placeholder="Search learner name or serial"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(1);
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              Sort: {option.label}
            </option>
          ))}
        </select>
        <select
          value={order}
          onChange={(e) => {
            setOrder(e.target.value as 'asc' | 'desc');
            setPage(1);
          }}
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
        <select
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          <option value={20}>20 / page</option>
          <option value={50}>50 / page</option>
          <option value={100}>100 / page</option>
        </select>
      </div>

      {exportError && (
        <div className="error-banner" role="alert">
          Export failed: {exportError}
        </div>
      )}

      {loading ? (
        <div className="state">Loading certificates…</div>
      ) : error ? (
        <div className="state error" role="alert">
          <p>{error}</p>
          <button className="btn" onClick={() => setRetryToken((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="state">No certificates found.</div>
      ) : (
        <>
          <table className="cert-table">
            <thead>
              <tr>
                <th>Serial</th>
                <th>Learner</th>
                <th>Course</th>
                <th>Status</th>
                <th>Issued (local)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((cert) => (
                <tr
                  key={cert.id}
                  className="clickable"
                  onClick={() => onSelectCertificate(cert.id)}
                >
                  <td>{cert.serialNumber}</td>
                  <td>{cert.learnerName}</td>
                  <td>{cert.courseTitle}</td>
                  <td>
                    <span className={`status status-${cert.status}`}>{cert.status}</span>
                  </td>
                  <td>{cert.issuedDateLocal}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button
              className="btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span>
              Page {page} of {totalPages} ({total} total)
            </span>
            <button
              className="btn"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
