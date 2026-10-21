import React from 'react';
import { createRoot } from 'react-dom/client';
import { Workbench } from './workbench.js';
import WorkbenchAppearance from './appearance/WorkbenchAppearance.js';
import './styles.css';
import './appearance/workbench-theme.css';
import './appearance/workbench-layout.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><WorkbenchAppearance><Workbench /></WorkbenchAppearance></React.StrictMode>);
