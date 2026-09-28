import './styles.css';
import { startApp } from './app.ts';
import { createDemoApi } from './demo/demo-api.ts';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app element');
}
void startApp(root, createDemoApi(), { timeZone: 'Asia/Seoul', demo: true });
