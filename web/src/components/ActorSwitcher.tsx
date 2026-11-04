import { Actor } from '../api';

interface Props {
  actors: Actor[];
  actorId: string | null;
  loading: boolean;
  error: string | null;
  onChange: (email: string) => void;
}

export function ActorSwitcher({ actors, actorId, loading, error, onChange }: Props) {
  if (loading) {
    return <span className="actor-loading">Loading actors…</span>;
  }

  if (error) {
    return (
      <span className="actor-error" role="alert">
        Actors unavailable: {error}
      </span>
    );
  }

  return (
    <label className="actor-switcher">
      <span className="actor-label">Actor</span>
      <select value={actorId ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          Select an actor
        </option>
        {actors.map((actor) => (
          <option key={actor.email} value={actor.email}>
            {actor.email} ({actor.tenant})
          </option>
        ))}
      </select>
    </label>
  );
}
