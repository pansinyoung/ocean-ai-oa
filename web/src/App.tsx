import { useEffect, useState } from 'react';
import {
  Actor,
  errorMessage,
  fetchActors,
  getStoredActorId,
  storeActorId,
} from './api';
import { ActorSwitcher } from './components/ActorSwitcher';
import { BulkIssue } from './components/BulkIssue';
import { CertificateDetail } from './components/CertificateDetail';
import { CertificateList } from './components/CertificateList';

export default function App() {
  const [actors, setActors] = useState<Actor[]>([]);
  const [actorsLoading, setActorsLoading] = useState(true);
  const [actorsError, setActorsError] = useState<string | null>(null);
  const [actorId, setActorId] = useState<string | null>(null);
  const [selectedCertificateId, setSelectedCertificateId] = useState<number | null>(null);
  const [listRefreshToken, setListRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchActors();
        if (cancelled) return;
        setActors(list);
        setActorsError(null);

        const stored = getStoredActorId();
        const next =
          stored && list.some((actor) => actor.email === stored)
            ? stored
            : (list[0]?.email ?? null);
        storeActorId(next);
        setActorId(next);
      } catch (err) {
        if (!cancelled) setActorsError(errorMessage(err));
      } finally {
        if (!cancelled) setActorsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshList = () => setListRefreshToken((n) => n + 1);

  const handleChangeActor = (email: string) => {
    storeActorId(email);
    setActorId(email);
    setSelectedCertificateId(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Certificate Admin Console</h1>
        <ActorSwitcher
          actors={actors}
          actorId={actorId}
          loading={actorsLoading}
          error={actorsError}
          onChange={handleChangeActor}
        />
      </header>

      {actorId === null ? (
        <div className="placeholder">
          <p>Select an actor to continue.</p>
        </div>
      ) : (
        <main className="app-main">
          <section className="panel">
            <BulkIssue actorId={actorId} onIssued={refreshList} />
          </section>
          <section className="panel">
            <CertificateList
              actorId={actorId}
              refreshToken={listRefreshToken}
              onSelectCertificate={setSelectedCertificateId}
            />
          </section>
        </main>
      )}

      {selectedCertificateId !== null && (
        <CertificateDetail
          certificateId={selectedCertificateId}
          onClose={() => setSelectedCertificateId(null)}
          onRevoked={() => {
            setSelectedCertificateId(null);
            refreshList();
          }}
        />
      )}
    </div>
  );
}
