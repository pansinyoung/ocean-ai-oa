import { useEffect, useState } from 'react';
import {
  CertificateDetail as CertificateDetailData,
  errorMessage,
  fetchCertificate,
  revokeCertificate,
} from '../api';

interface Props {
  certificateId: number;
  onClose: () => void;
  onRevoked: () => void;
}

export function CertificateDetail({ certificateId, onClose, onRevoked }: Props) {
  const [data, setData] = useState<CertificateDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRevokeError(null);
    fetchCertificate(certificateId)
      .then((detail) => {
        if (cancelled) return;
        setData(detail);
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
  }, [certificateId]);

  const handleRevoke = async () => {
    if (!data) return;
    if (!window.confirm(`Revoke certificate ${data.serialNumber} for ${data.learnerName}?`)) {
      return;
    }
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeCertificate(data.id);
      setData({ ...data, status: 'revoked' });
      onRevoked();
    } catch (err) {
      setRevokeError(errorMessage(err));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Certificate detail</h2>
          <button className="btn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        {loading ? (
          <div className="state">Loading…</div>
        ) : error ? (
          <div className="state error" role="alert">
            {error}
          </div>
        ) : data ? (
          <div className="detail">
            <dl className="detail-list">
              <dt>Serial</dt>
              <dd>{data.serialNumber}</dd>
              <dt>Learner</dt>
              <dd>{data.learnerName}</dd>
              <dt>Course</dt>
              <dd>{data.courseTitle}</dd>
              <dt>Status</dt>
              <dd>
                <span className={`status status-${data.status}`}>{data.status}</span>
              </dd>
              <dt>Issued (local)</dt>
              <dd>{data.issuedAtLocal}</dd>
              {data.revokedAtLocal && (
                <>
                  <dt>Revoked (local)</dt>
                  <dd>{data.revokedAtLocal}</dd>
                </>
              )}
            </dl>

            {data.status !== 'revoked' && (
              <button
                className="btn btn-danger"
                onClick={handleRevoke}
                disabled={revoking}
              >
                {revoking ? 'Revoking…' : 'Revoke'}
              </button>
            )}

            {revokeError && (
              <div className="error-banner" role="alert">
                Revoke failed: {revokeError}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
