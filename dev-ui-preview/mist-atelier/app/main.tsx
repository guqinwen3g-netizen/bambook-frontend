import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/urbanist/300.css';
import '@fontsource/urbanist/400.css';
import '@fontsource/urbanist/500.css';
import '@fontsource/urbanist/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '../../../styles/mist/mist.css';
import { ReferenceApp } from './ReferenceApp';

const style = document.createElement('style');
style.textContent = 'html,body{margin:0;height:100%;overflow:hidden}@media (max-width:760px){html,body{overflow:auto}}';
document.head.appendChild(style);
createRoot(document.getElementById('root')!).render(<React.StrictMode><ReferenceApp /></React.StrictMode>);
