import { useEffect, useState } from 'react';
import {
  BulkIssueResult,
  Course,
  bulkIssue,
  errorMessage,
  fetchCourses,
} from '../api';

interface Props {
  actorId: string;
  onIssued: () => void;
}

export function BulkIssue({ actorId, onIssued }: Props) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(true);
  const [coursesError, setCoursesError] = useState<string | null>(null);

  const [courseId, setCourseId] = useState<number | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [result, setResult] = useState<BulkIssueResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCoursesLoading(true);
    setCoursesError(null);
    fetchCourses()
      .then((list) => {
        if (cancelled) return;
        setCourses(list);
        setCoursesLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setCoursesError(errorMessage(err));
        setCoursesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actorId]);

  const selectCourse = (id: number) => {
    setCourseId(id);
    setIdempotencyKey(crypto.randomUUID());
    setResult(null);
    setError(null);
  };

  const handleIssue = async () => {
    if (courseId === null || inFlight) return;
    // Reuse the key across retries of the same operation; it was generated
    // when the course was selected and only regenerates on course change.
    const key = idempotencyKey ?? crypto.randomUUID();
    if (idempotencyKey === null) setIdempotencyKey(key);

    setInFlight(true);
    setError(null);
    try {
      const res = await bulkIssue(courseId, key);
      setResult(res);
      onIssued();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div className="bulk-issue">
      <h2>Bulk issue</h2>

      {coursesLoading ? (
        <div className="state">Loading courses…</div>
      ) : coursesError ? (
        <div className="state error" role="alert">
          {coursesError}
        </div>
      ) : (
        <>
          <div className="controls">
            <select
              value={courseId ?? ''}
              onChange={(e) => selectCourse(Number(e.target.value))}
            >
              <option value="" disabled>
                Select a course
              </option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.title} (#{course.id})
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={courseId === null || inFlight}
              onClick={handleIssue}
            >
              {inFlight ? 'Issuing…' : 'Issue all eligible'}
            </button>
          </div>

          {error && (
            <div className="error-banner" role="alert">
              Bulk issue failed: {error}
            </div>
          )}

          {result && (
            <div className="bulk-result">
              <div className="summary">
                Issued: {result.summary.issued} · Skipped: {result.summary.skipped} · Failed:{' '}
                {result.summary.failed}
              </div>
              {result.outcomes.length > 0 ? (
                <table className="cert-table outcomes">
                  <thead>
                    <tr>
                      <th>Learner</th>
                      <th>Status</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.outcomes.map((outcome) => (
                      <tr key={outcome.learnerId}>
                        <td>{outcome.learnerName}</td>
                        <td>
                          <span className={`status status-${outcome.status}`}>
                            {outcome.status}
                          </span>
                        </td>
                        <td>{outcome.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="state">No eligible learners.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
