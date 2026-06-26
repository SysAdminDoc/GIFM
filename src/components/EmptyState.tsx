export function EmptyState({
  icon,
  title,
  body,
  compact = false
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{body}</small>
      </span>
    </div>
  );
}

export function StatusTile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: 'cyan' | 'amber' | 'lime' | 'muted' }) {
  return (
    <div className={`status-tile ${tone}`}>
      <span className="status-tile-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
    </div>
  );
}
