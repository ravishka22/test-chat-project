import { Sparkles } from "lucide-react";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <Sparkles size={18} strokeWidth={2.2} />
      </span>
      {!compact && <span>Atlas</span>}
    </div>
  );
}
