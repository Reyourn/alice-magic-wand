import { useState } from 'react';
import { ArrowUpRight, Eye, PanelsTopLeft } from 'lucide-react';
import { Workbench } from '../workbench.js';
import WorkbenchAppearance from '../appearance/WorkbenchAppearance.js';

export default function AppearancePreview() {
  const [backgroundOnly, setBackgroundOnly] = useState(false);
  return <WorkbenchAppearance className={`appearance-preview${backgroundOnly ? ' appearance-preview--background-only' : ''}`}>
    <div className="appearance-toolbar" aria-label="外观预览工具栏">
      <span className="appearance-title">02 · 静态背景</span>
      <span className="appearance-badge">当前工作台 · 只读</span>
      <div className="appearance-actions">
        <button className="background-toggle" aria-pressed={backgroundOnly} onClick={() => setBackgroundOnly(current => !current)}>
          {backgroundOnly ? <PanelsTopLeft size={13} /> : <Eye size={13} />}<span>{backgroundOnly ? '显示工作台' : '只看背景'}</span>
        </button>
        <a href="/">返回工作台<ArrowUpRight size={13} /></a>
      </div>
    </div>
    <div className="appearance-workbench" inert={backgroundOnly} aria-hidden={backgroundOnly || undefined}>
      <Workbench readOnlyPreview />
    </div>
  </WorkbenchAppearance>;
}
