export function LoopLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`loop-logo ${compact ? 'compact' : ''}`} aria-hidden="true">
      <span />
      <span />
    </span>
  );
}
