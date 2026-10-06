import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createApplication } from '../../apps/server/dist/bootstrap/application.js';
import { loadConfig } from '../../apps/server/dist/platform/config/index.js';

const browserCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const browserPath = browserCandidates.find(existsSync);
if (!browserPath)
  throw new Error(
    'Install or provide a Chromium browser for the end-to-end test.',
  );

const silentLogger = { emit() {}, afterCommit() {} };
let root = '';
let port = 0;
let origin = '';
let application: Awaited<ReturnType<typeof createApplication>>;
let browser: Browser;

const findPort = async () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No available loopback port.'));
        return;
      }
      const found = address.port;
      server.close((error) => (error ? reject(error) : resolve(found)));
    });
  });

async function openSession(context: BrowserContext, username: string) {
  const page = await context.newPage();
  await page.route('**/favicon.ico', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  const consoleErrors: Array<{
    text: string;
    location: { url: string; lineNumber: number; columnNumber: number };
  }> = [];
  const failedRequests: string[] = [];
  const messagePosts: string[] = [];
  let loginAccepted = false;
  let unauthenticatedProbeCount = 0;
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({
        text: message.text(),
        location: message.location(),
      });
  });
  page.on('pageerror', (error) =>
    consoleErrors.push({
      text: error.message,
      location: { url: '', lineNumber: 0, columnNumber: 0 },
    }),
  );
  page.on('response', (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (
      request.method() === 'POST' &&
      url.pathname === '/api/v1/session' &&
      response.status() === 201
    )
      loginAccepted = true;
    if (
      response.status() === 401 &&
      request.method() === 'GET' &&
      url.pathname === '/api/v1/me' &&
      !loginAccepted
    )
      unauthenticatedProbeCount++;
    else if (response.status() >= 400)
      failedRequests.push(
        `${request.method()} ${response.status()} ${response.url()}`,
      );
  });
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/messages$/.test(new URL(request.url()).pathname)
    )
      messagePosts.push(request.url());
  });
  await page.goto(origin);
  await page.getByLabel('사용자 이름').fill(username);
  await page.getByLabel('비밀번호').fill('dev-only');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(
    page.getByText(username === 'alice' ? 'Alice' : 'Bob', { exact: true }),
  ).toBeVisible();
  return {
    page,
    consoleErrors,
    failedRequests,
    messagePosts,
    unauthenticatedProbeCount,
  };
}
const chatText = (page: Page, text: string) =>
  page.locator('.chat-panel').getByText(text, { exact: true });

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jm-browser-e2e-'));
  port = await findPort();
  origin = `http://127.0.0.1:${port}`;
  const config = loadConfig(
    {
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_ORIGIN: origin,
      WEB_DIST: path.resolve('apps/web/dist'),
    },
    root,
  );
  application = await createApplication(config, {
    logger: silentLogger,
    maintenance: false,
  });
  await application.identity.login('dev-a', 'alice', 'dev-only');
  await application.identity.login('dev-a', 'bob', 'dev-only');
  await application.app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
  });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  if (application) await application.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test('Alice and Bob exchange messages and an attachment in isolated browser sessions', async () => {
  test.setTimeout(30_000);
  const aliceContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const bobContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  try {
    const alice = await openSession(aliceContext, 'alice');
    const bob = await openSession(bobContext, 'bob');

    await alice.page.getByRole('button', { name: '새 대화 만들기' }).click();
    await alice.page.getByRole('radio', { name: '개인' }).check();
    const bobOption = alice.page
      .getByLabel('참여자')
      .locator('option')
      .filter({ hasText: 'Bob' });
    const bobId = await bobOption.getAttribute('value');
    expect(bobId).toBeTruthy();
    await alice.page.getByLabel('참여자').selectOption(bobId!);
    await alice.page.getByRole('button', { name: '대화 시작' }).click();
    await expect(
      alice.page.getByRole('heading', { name: 'Alice, Bob' }),
    ).toBeVisible();

    await expect(
      bob.page.getByRole('button', { name: /Alice, Bob/ }),
    ).toBeVisible();
    await bob.page.getByRole('button', { name: /Alice, Bob/ }).click();
    const composer = alice.page.getByLabel('메시지 입력');
    await composer.fill('Hello from Alice');
    await composer.press('Enter');
    await expect(chatText(bob.page, 'Hello from Alice')).toBeVisible();
    await expect.poll(() => alice.messagePosts.length).toBe(1);

    await composer.fill('안녕하세요 Bob');
    await composer.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent('compositionstart', {
          bubbles: true,
          data: '안녕',
        }),
      );
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          isComposing: true,
        }),
      );
      element.dispatchEvent(
        new CompositionEvent('compositionend', {
          bubbles: true,
          data: '안녕하세요 Bob',
        }),
      );
    });
    expect(alice.messagePosts).toHaveLength(1);
    await alice.page.getByRole('button', { name: '전송' }).click();
    await expect(chatText(bob.page, '안녕하세요 Bob')).toBeVisible();
    await expect.poll(() => alice.messagePosts.length).toBe(2);

    const attachmentBytes = Buffer.alloc(5_000_000, 0x61);
    await alice.page
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'browser-roundtrip.txt',
        mimeType: 'text/plain',
        buffer: attachmentBytes,
      });
    await expect(alice.page.locator('.attachment-staging')).toContainText(
      'browser-roundtrip.txt',
    );
    await composer.fill('Attached from the browser');
    await alice.page.getByRole('button', { name: '전송' }).click();
    await expect(chatText(bob.page, 'Attached from the browser')).toBeVisible();
    const downloadButton = bob.page.getByRole('button', {
      name: /첨부 파일 다운로드/,
    });
    await expect(downloadButton).toBeVisible();
    const [download] = await Promise.all([
      bob.page.waitForEvent('download'),
      downloadButton.click(),
    ]);
    const downloaded = await readFile(await download.path());
    expect(downloaded.equals(attachmentBytes)).toBe(true);

    await bob.page.reload();
    await expect(bob.page.getByText('Bob', { exact: true })).toBeVisible();
    await bob.page.getByRole('button', { name: /Alice, Bob/ }).click();
    await expect(chatText(bob.page, 'Hello from Alice')).toBeVisible();
    await expect(chatText(bob.page, '안녕하세요 Bob')).toBeVisible();
    await expect(chatText(bob.page, 'Attached from the browser')).toBeVisible();

    const evidenceDir = path.resolve('tests/e2e/evidence');
    await mkdir(evidenceDir, { recursive: true });
    await alice.page.screenshot({
      path: path.join(evidenceDir, 'desktop-chat.png'),
      fullPage: true,
    });
    await bob.page.setViewportSize({ width: 360, height: 800 });
    await expect(bob.page.locator('.messenger-shell')).toHaveClass(
      /conversation-open/,
    );
    await expect(
      bob.page.getByRole('heading', { name: 'Alice, Bob' }),
    ).toBeVisible();
    const mobileWidths = await bob.page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(mobileWidths.document).toBeLessThanOrEqual(mobileWidths.viewport);
    expect(mobileWidths.body).toBeLessThanOrEqual(mobileWidths.viewport);
    await bob.page.screenshot({
      path: path.join(evidenceDir, 'mobile-chat.png'),
      fullPage: true,
    });
    expect(alice.failedRequests).toEqual([]);
    expect(bob.failedRequests).toEqual([]);
    const assertConsoleErrors = (
      errors: typeof alice.consoleErrors,
      probeCount: number,
    ) => {
      expect(probeCount).toBe(1);
      const expected =
        'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
      const allowed = errors
        .map((error, index) => ({ error, index }))
        .filter(
          ({ error }) =>
            error.text === expected &&
            error.location.url === `${origin}/api/v1/me`,
        );
      expect(allowed.length).toBeLessThanOrEqual(1);
      expect(
        errors.filter((_error, index) => index !== allowed[0]?.index),
      ).toEqual([]);
    };
    assertConsoleErrors(alice.consoleErrors, alice.unauthenticatedProbeCount);
    assertConsoleErrors(bob.consoleErrors, bob.unauthenticatedProbeCount);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
