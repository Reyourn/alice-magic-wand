import React from 'react';
import {createRoot} from 'react-dom/client';
import AppearancePreview from './AppearancePreview.js';
import '../styles.css';
import '../appearance/workbench-theme.css';
import '../appearance/workbench-layout.css';
import './preview-theme.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AppearancePreview/></React.StrictMode>);
