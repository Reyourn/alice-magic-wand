import type { ReactNode } from 'react';

/** Decorative static image shared by both workbench entry points. */
export default function WorkbenchAppearance({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`workbench-appearance${className ? ` ${className}` : ''}`}>
    <div className="workbench-wallpaper" aria-hidden="true">
      <img src="/backgrounds/zero-two-wallpaper.png" alt="" draggable={false} decoding="async" fetchPriority="high" />
    </div>
    {children}
  </div>;
}
