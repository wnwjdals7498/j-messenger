import { createDom, tick, settle } from './dom.ts';
import { startApp } from '../../src/app.ts';
import { createDemoApi } from '../../src/demo/demo-api.ts';

export async function startDemo() {
  const dom = createDom();
  const api = createDemoApi({ now: () => new Date('2026-09-23T06:00:00Z') });
  await startApp(dom.root, api, { timeZone: 'Asia/Seoul', demo: true });
  return { ...dom, api };
}

export async function login(root: HTMLElement, username: string, serverId = 'mail-a') {
  const form = root.querySelector('form.login')!;
  const select = form.querySelector('select[name=\"serverId\"]')!;
  const usernameInput = form.querySelector('input[name=\"username\"]')!;
  const passwordInput = form.querySelector('input[name=\"password\"]')!;
  const button = form.querySelector('button[type=\"submit\"]')!;
  select.value = serverId;
  usernameInput.value = username;
  passwordInput.value = 'pw';
  button.click();
  // Wait for view to change (either to 'main' on success or stay 'login' on failure)
  for (let i = 0; i < 50; i++) {
    await tick();
    if (root.dataset.view === 'main' || root.dataset.view === 'login') break;
  }
  await settle();
  // Wait for showMain to complete if we're on main view
  if (root.dataset.view === 'main') {
    const app = await import('../../src/app.ts');
    const promises = (app.startApp as any).__getAllShowMainPromises();
    for (const p of promises) {
      await p;
    }
  }
}

export async function startAndLogin(username = 'alice', serverId = 'mail-a') {
  const demo = await startDemo();
  await login(demo.root, username, serverId);
  return demo;
}

export function sidebarIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.sidebar button.conversation')).map(b => b.getAttribute('data-id')!);
}

export function messageIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.messages article.message')).map(a => a.getAttribute('data-id')!);
}
