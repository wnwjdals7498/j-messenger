import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const FILE_LIMIT = 5_000_000;
const REQUEST_TIMEOUT_MS = 15_000;

function safeFailure(test, code = 'assertion_failed') {
  const error = new Error(code);
  error.test = test;
  error.code = code;
  return error;
}

function assert(condition, test, code) {
  if (!condition) throw safeFailure(test, code);
}

function uuidFromTag(tag, label) {
  const hex = createHash('sha256')
    .update(`${tag}:${label}`)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeOptions(options) {
  if (!options || typeof options.baseURL !== 'string')
    throw new TypeError('baseURL is required');
  const url = new URL(options.baseURL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new TypeError('baseURL must be an HTTP(S) origin');
  }
  if (url.protocol === 'https:' && !options.trustedCA) {
    throw new TypeError(
      'HTTPS verification requires an explicit trustedCA file',
    );
  }
  const tag = String(options.tag ?? randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
  if (!tag) throw new TypeError('tag must contain letters or digits');
  return { origin: url.origin, tag, trustedCA: options.trustedCA };
}

async function makeTransport(options, overrides = {}) {
  const ca =
    overrides.ca ??
    (options.trustedCA ? await readFile(options.trustedCA) : undefined);
  const client = options.origin.startsWith('https:') ? https : http;
  return async function request(
    path,
    { method = 'GET', headers = {}, body } = {},
  ) {
    const url = new URL(path, options.origin);
    return new Promise((resolve, reject) => {
      const req = client.request(
        url,
        {
          method,
          headers,
          ...(ca ? { ca } : {}),
          ...(overrides.lookup ? { lookup: overrides.lookup } : {}),
          rejectUnauthorized: true,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              bytes: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(safeFailure('transport', 'timeout')));
      req.on('error', () => reject(safeFailure('transport', 'network_error')));
      if (body) req.write(body);
      req.end();
    });
  };
}

function jsonBody(response) {
  try {
    return JSON.parse(response.bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function checkStatus(response, status, test) {
  assert(response.status === status, test, `http_${response.status}`);
}

function checkErrorCode(response, status, code, test) {
  checkStatus(response, status, test);
  assert(
    jsonBody(response)?.error?.code === code,
    test,
    `error_${code}_expected`,
  );
}

async function api(
  request,
  path,
  { method, cookie, bearer, origin, body, headers = {} } = {},
) {
  const requestHeaders = { accept: 'application/json', ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (bearer) requestHeaders.authorization = `Bearer ${bearer}`;
  if (origin !== null && origin !== undefined) requestHeaders.origin = origin;
  let payload;
  if (body !== undefined) {
    payload = Buffer.from(JSON.stringify(body));
    requestHeaders['content-type'] = 'application/json';
    requestHeaders['content-length'] = String(payload.length);
  }
  return request(path, { method, headers: requestHeaders, body: payload });
}

async function login(
  request,
  username,
  serverId = 'dev-a',
  { origin, cookie } = {},
) {
  const response = await api(request, '/api/v1/session', {
    method: 'POST',
    ...(cookie ? { cookie } : {}),
    origin: origin === undefined ? null : origin,
    body: { serverId, username, password: 'dev-only' },
  });
  checkStatus(response, 201, `login_${username}`);
  const setCookie = response.headers['set-cookie'];
  const line = Array.isArray(setCookie)
    ? setCookie.find((entry) => entry.startsWith('jm_session='))
    : undefined;
  assert(line, `login_${username}`, 'cookie_missing');
  const credential = line.slice('jm_session='.length).split(';', 1)[0];
  return { cookie: `jm_session=${credential}`, user: jsonBody(response)?.data };
}

function multipart(filename, bytes, boundary) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function upload(
  request,
  cookie,
  origin,
  conversationId,
  filename,
  bytes,
  boundary,
) {
  const body = multipart(filename, bytes, boundary);
  return request(`/api/v1/conversations/${conversationId}/files`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
}

function createSocketFrameQueue(socket) {
  const frames = [];
  const waiters = [];
  let terminalError;

  const fail = (code) => {
    if (terminalError) return;
    terminalError = safeFailure('websocket', code);
    while (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(terminalError);
    }
  };

  socket.on('message', (data) => {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(data.toString());
    } else {
      frames.push(data.toString());
    }
  });
  socket.on('error', () => fail('connection_error'));
  socket.on('close', () => fail('closed_early'));

  return {
    next(timeoutMs = REQUEST_TIMEOUT_MS) {
      if (frames.length) return Promise.resolve(frames.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(safeFailure('websocket', 'timeout'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function nextSocketFrame(queue, timeoutMs = REQUEST_TIMEOUT_MS) {
  return queue.next(timeoutMs);
}

async function withSocket(options, cookie, run) {
  const url = new URL('/api/v1/events', options.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ca = options.trustedCA ? await readFile(options.trustedCA) : undefined;
  const socket = new WebSocket(url, {
    headers: { Origin: options.origin, Cookie: cookie },
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  });
  const frames = createSocketFrameQueue(socket);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(safeFailure('websocket', 'timeout')),
        REQUEST_TIMEOUT_MS,
      );
      const onOpen = () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve();
      };
      const onError = () => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        reject(safeFailure('websocket', 'connection_error'));
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    return await run(socket, frames);
  } finally {
    socket.close();
  }
}

function pushPass(tests, name) {
  tests.push({ name, passed: true });
}

function resultSummary(tests) {
  return {
    total: tests.length,
    passed: tests.filter((test) => test.passed).length,
    failed: tests.filter((test) => !test.passed).length,
  };
}

export async function verifyTlsRejections(input) {
  const options = normalizeOptions(input);
  if (!options.origin.startsWith('https:'))
    throw new TypeError('TLS rejection checks require HTTPS');
  const tests = [];

  const expectRejected = async (name, request) => {
    try {
      await request('/health/ready');
      tests.push({ name, passed: false, code: 'tls_connection_accepted' });
    } catch {
      tests.push({ name, passed: true });
    }
  };

  const defaultTrust = await makeTransport({
    ...options,
    trustedCA: undefined,
  });
  await expectRejected('default_trust_rejected', defaultTrust);

  const caBytes = await readFile(options.trustedCA);
  const pemCertificates =
    caBytes
      .toString('utf8')
      .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ??
    [];
  const suppliedFingerprints = new Set(
    pemCertificates.map((pem) => new X509Certificate(pem).fingerprint256),
  );
  const unrelatedRoot = tls.rootCertificates.find(
    (pem) => !suppliedFingerprints.has(new X509Certificate(pem).fingerprint256),
  );
  if (!unrelatedRoot)
    throw new TypeError('no unrelated built-in root certificate available');
  const untrustedCA = await makeTransport(options, {
    ca: Buffer.from(unrelatedRoot),
  });
  await expectRejected('untrusted_ca_rejected', untrustedCA);

  const target = new URL(options.origin);
  const targetAddress = target.hostname.replace(/^\[|\]$/g, '');
  const addressFamily = isIP(targetAddress);
  if (!addressFamily)
    throw new TypeError('hostname check requires a literal VM IP address');
  const wrongHostname = 'vm-certificate-name-check.invalid';
  const wrongOrigin = `https://${wrongHostname}:${target.port}`;
  const hostnameTransport = await makeTransport(
    { origin: wrongOrigin, trustedCA: options.trustedCA },
    {
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all)
          callback(null, [{ address: targetAddress, family: addressFamily }]);
        else callback(null, targetAddress, addressFamily);
      },
    },
  );
  await expectRejected(
    'wrong_certificate_hostname_rejected',
    hostnameTransport,
  );

  return {
    counts: resultSummary(tests),
    tests,
  };
}

export async function runVmVerification(input) {
  const options = normalizeOptions(input);
  const request = await makeTransport(options);
  const tests = [];
  const fixture = { tag: options.tag };

  try {
    const ready = await request('/health/ready');
    checkStatus(ready, 200, 'ready');
    assert(jsonBody(ready)?.data?.ready === true, 'ready', 'not_ready');
    const page = await request('/');
    checkStatus(page, 200, 'web_page');
    assert(
      /text\/html/i.test(String(page.headers['content-type'] ?? '')),
      'web_page',
      'html_expected',
    );
    pushPass(tests, 'ready_and_page');

    const alice = await login(request, 'alice', 'dev-a', {
      origin: options.origin,
    });
    const bob = await login(request, 'bob', 'dev-a', {
      origin: options.origin,
    });
    const carol = await login(request, 'carol', 'dev-a', {
      origin: options.origin,
    });
    assert(
      alice.user?.id !== bob.user?.id && alice.cookie !== bob.cookie,
      'distinct_sessions',
      'sessions_not_distinct',
    );
    assert(
      alice.user?.serverId === 'dev-a' && bob.user?.serverId === 'dev-a',
      'distinct_sessions',
      'wrong_fixture_server',
    );
    pushPass(tests, 'distinct_sessions');

    const directResponse = await api(request, '/api/v1/conversations', {
      method: 'POST',
      cookie: alice.cookie,
      origin: options.origin,
      body: {
        kind: 'direct',
        memberIds: [bob.user.id],
        clientRequestId: uuidFromTag(options.tag, 'direct'),
      },
    });
    assert(
      directResponse.status === 200 || directResponse.status === 201,
      'direct_conversation',
      `http_${directResponse.status}`,
    );
    const directId = jsonBody(directResponse)?.data?.id;
    assert(
      typeof directId === 'string',
      'direct_conversation',
      'conversation_id_missing',
    );
    fixture.directConversationId = directId;

    const groupResponse = await api(request, '/api/v1/conversations', {
      method: 'POST',
      cookie: alice.cookie,
      origin: options.origin,
      body: {
        kind: 'group',
        memberIds: [bob.user.id, carol.user.id],
        title: `VM verification ${options.tag}`,
        clientRequestId: uuidFromTag(options.tag, 'group'),
      },
    });
    checkStatus(groupResponse, 201, 'group_conversation');
    const groupId = jsonBody(groupResponse)?.data?.id;
    assert(
      typeof groupId === 'string',
      'group_conversation',
      'conversation_id_missing',
    );
    fixture.groupConversationId = groupId;
    pushPass(tests, 'direct_and_group_conversations');

    const directMessageKey = uuidFromTag(options.tag, 'dedup-message');
    const directPath = `/api/v1/conversations/${directId}/messages`;
    const messageBody = {
      clientMessageId: directMessageKey,
      text: `verification ${options.tag}`,
    };
    const firstMessage = await api(request, directPath, {
      method: 'POST',
      cookie: alice.cookie,
      origin: options.origin,
      body: messageBody,
    });
    checkStatus(firstMessage, 201, 'duplicate_message_first');
    const firstMessageData = jsonBody(firstMessage)?.data;
    const retryMessage = await api(request, directPath, {
      method: 'POST',
      cookie: alice.cookie,
      origin: options.origin,
      body: messageBody,
    });
    checkStatus(retryMessage, 200, 'duplicate_message_retry');
    assert(
      jsonBody(retryMessage)?.data?.id === firstMessageData?.id,
      'duplicate_message_retry',
      'retry_created_new_message',
    );
    const secondMessage = await api(request, directPath, {
      method: 'POST',
      cookie: alice.cookie,
      origin: options.origin,
      body: {
        clientMessageId: uuidFromTag(options.tag, 'second-message'),
        text: `second ${options.tag}`,
      },
    });
    checkStatus(secondMessage, 201, 'read_monotonicity');
    const secondMessageId = jsonBody(secondMessage)?.data?.id;
    const listed = await api(request, `${directPath}?limit=100`, {
      cookie: alice.cookie,
    });
    checkStatus(listed, 200, 'duplicate_message_count');
    assert(
      jsonBody(listed)?.data?.filter(
        (item) => item.clientMessageId === directMessageKey,
      ).length === 1,
      'duplicate_message_count',
      'message_count_not_one',
    );
    fixture.directMessageId = firstMessageData?.id;
    pushPass(tests, 'duplicate_message_one_record');

    const nonmember = await api(
      request,
      `/api/v1/conversations/${directId}/messages`,
      { cookie: carol.cookie },
    );
    checkErrorCode(nonmember, 404, 'not_found', 'nonmember_hidden');
    const mallory = await login(request, 'mallory', 'dev-b', {
      origin: options.origin,
    });
    const crossTenant = await api(
      request,
      `/api/v1/conversations/${directId}/messages`,
      { cookie: mallory.cookie },
    );
    checkErrorCode(crossTenant, 404, 'not_found', 'cross_tenant_hidden');
    pushPass(tests, 'cross_tenant_and_nonmember_404');

    const readForward = await api(
      request,
      `/api/v1/conversations/${directId}/read`,
      {
        method: 'PUT',
        cookie: bob.cookie,
        origin: options.origin,
        body: { lastReadMessageId: secondMessageId },
      },
    );
    checkStatus(readForward, 200, 'read_forward');
    const readBackward = await api(
      request,
      `/api/v1/conversations/${directId}/read`,
      {
        method: 'PUT',
        cookie: bob.cookie,
        origin: options.origin,
        body: { lastReadMessageId: firstMessageData?.id },
      },
    );
    checkStatus(readBackward, 200, 'read_backward');
    assert(
      jsonBody(readBackward)?.data?.lastReadMessageId === secondMessageId,
      'read_monotonicity',
      'read_position_moved_backwards',
    );
    const readState = await api(
      request,
      `/api/v1/conversations/${directId}/read`,
      { cookie: bob.cookie },
    );
    checkStatus(readState, 200, 'read_state');
    assert(
      jsonBody(readState)?.data?.some(
        (entry) =>
          entry.userId === bob.user.id &&
          entry.lastReadMessageId === secondMessageId,
      ),
      'read_state',
      'read_state_not_persisted',
    );
    pushPass(tests, 'read_state_monotonic');

    const conversations = await api(
      request,
      '/api/v1/conversations?limit=100',
      { cookie: alice.cookie },
    );
    checkStatus(conversations, 200, 'signed_sync_setup');
    const snapshotCursor = jsonBody(conversations)?.snapshotCursor;
    assert(
      typeof snapshotCursor === 'string' && !/^\d+$/.test(snapshotCursor),
      'signed_sync_setup',
      'cursor_not_opaque',
    );
    const validSync = await api(
      request,
      `/api/v1/sync?after=${encodeURIComponent(snapshotCursor)}&limit=100`,
      { cookie: alice.cookie },
    );
    checkStatus(validSync, 200, 'signed_sync');
    const badSync = await api(
      request,
      `/api/v1/sync?after=${encodeURIComponent(`${snapshotCursor}x`)}&limit=100`,
      { cookie: alice.cookie },
    );
    checkErrorCode(badSync, 400, 'bad_request', 'signed_sync_tamper');
    assert(
      typeof jsonBody(validSync)?.nextCursor === 'string' &&
        typeof jsonBody(validSync)?.through === 'string',
      'signed_sync',
      'sync_cursors_missing',
    );
    pushPass(tests, 'signed_sync_cursor');

    const originGuard = await api(request, '/api/v1/conversations', {
      method: 'POST',
      cookie: alice.cookie,
      origin: 'https://invalid-origin.example',
      body: {
        kind: 'direct',
        memberIds: [bob.user.id],
        clientRequestId: uuidFromTag(options.tag, 'bad-origin'),
      },
    });
    checkErrorCode(originGuard, 403, 'forbidden', 'cookie_origin_guard');
    const missingOrigin = await api(request, directPath, {
      method: 'POST',
      cookie: alice.cookie,
      origin: null,
      body: {
        clientMessageId: uuidFromTag(options.tag, 'missing-origin'),
        text: 'origin check',
      },
    });
    checkErrorCode(
      missingOrigin,
      403,
      'forbidden',
      'cookie_origin_guard_missing',
    );
    pushPass(tests, 'cookie_origin_guard');

    await withSocket(options, alice.cookie, async (socket, frames) => {
      const readyFrame = JSON.parse(await nextSocketFrame(frames));
      assert(
        readyFrame?.type === 'ready' &&
          typeof readyFrame.cursor === 'string' &&
          /^\d+$/.test(readyFrame.position),
        'websocket_ready',
        'invalid_ready_frame',
      );
      const wsMessageKey = uuidFromTag(options.tag, 'ws-message');
      const sent = await api(
        request,
        `/api/v1/conversations/${groupId}/messages`,
        {
          method: 'POST',
          cookie: alice.cookie,
          origin: options.origin,
          body: {
            clientMessageId: wsMessageKey,
            text: `websocket ${options.tag}`,
          },
        },
      );
      checkStatus(sent, 201, 'websocket_commit');
      const event = JSON.parse(await nextSocketFrame(frames));
      assert(
        event?.type === 'message.created.v1' &&
          event?.data?.id === jsonBody(sent)?.data?.id &&
          event?.conversationId === groupId,
        'websocket_commit',
        'committed_event_missing',
      );
      assert(
        BigInt(event.eventId) > BigInt(readyFrame.position),
        'websocket_commit',
        'event_precedes_ready_watermark',
      );
      fixture.groupMessageId = event.data.id;
      fixture.websocketEventId = event.eventId;
    });
    pushPass(tests, 'websocket_committed_message');

    const smallBytes = Buffer.from(
      `small VM attachment ${options.tag}`,
      'utf8',
    );
    const smallUpload = await upload(
      request,
      alice.cookie,
      options.origin,
      groupId,
      'small.txt',
      smallBytes,
      `jm-${options.tag}-small`,
    );
    checkStatus(smallUpload, 201, 'small_txt_upload');
    const smallFileId = jsonBody(smallUpload)?.data?.id;
    assert(
      typeof smallFileId === 'string',
      'small_txt_upload',
      'file_id_missing',
    );
    const smallBind = await api(
      request,
      `/api/v1/conversations/${groupId}/messages`,
      {
        method: 'POST',
        cookie: alice.cookie,
        origin: options.origin,
        body: {
          clientMessageId: uuidFromTag(options.tag, 'small-file-message'),
          text: `small file ${options.tag}`,
          fileIds: [smallFileId],
        },
      },
    );
    checkStatus(smallBind, 201, 'small_txt_bind');
    const smallDownload = await request(
      `/api/v1/files/${smallFileId}/content`,
      { headers: { cookie: bob.cookie, origin: options.origin } },
    );
    checkStatus(smallDownload, 200, 'small_txt_download');
    assert(
      smallDownload.bytes.equals(smallBytes),
      'small_txt_download',
      'bytes_mismatch',
    );
    pushPass(tests, 'small_txt_upload_bind_download');

    const exactBytes = Buffer.alloc(FILE_LIMIT, 0x61);
    const exactUpload = await upload(
      request,
      alice.cookie,
      options.origin,
      groupId,
      'exact-limit.txt',
      exactBytes,
      `jm-${options.tag}-exact`,
    );
    checkStatus(exactUpload, 201, 'exact_limit_upload');
    const exactFileId = jsonBody(exactUpload)?.data?.id;
    assert(
      typeof exactFileId === 'string' &&
        jsonBody(exactUpload)?.data?.sizeBytes === FILE_LIMIT,
      'exact_limit_upload',
      'exact_size_not_accepted',
    );
    fixture.exactFileId = exactFileId;
    const exactBind = await api(
      request,
      `/api/v1/conversations/${groupId}/messages`,
      {
        method: 'POST',
        cookie: alice.cookie,
        origin: options.origin,
        body: {
          clientMessageId: uuidFromTag(options.tag, 'exact-file-message'),
          text: `exact file ${options.tag}`,
          fileIds: [exactFileId],
        },
      },
    );
    checkStatus(exactBind, 201, 'exact_limit_bind');
    fixture.exactFileMessageId = jsonBody(exactBind)?.data?.id;
    const exactDownload = await request(
      `/api/v1/files/${exactFileId}/content`,
      { headers: { cookie: bob.cookie, origin: options.origin } },
    );
    checkStatus(exactDownload, 200, 'exact_limit_download');
    assert(
      exactDownload.bytes.length === FILE_LIMIT &&
        exactDownload.bytes.equals(exactBytes),
      'exact_limit_download',
      'bytes_mismatch',
    );
    pushPass(tests, 'exact_5mb_upload_bind_download');

    const tooLarge = await upload(
      request,
      alice.cookie,
      options.origin,
      groupId,
      'over-limit.txt',
      Buffer.alloc(FILE_LIMIT + 1, 0x61),
      `jm-${options.tag}-large`,
    );
    checkErrorCode(tooLarge, 413, 'too_large', 'over_limit_upload');
    const badFormat = await upload(
      request,
      alice.cookie,
      options.origin,
      groupId,
      'blocked.exe',
      Buffer.from('x'),
      `jm-${options.tag}-format`,
    );
    checkErrorCode(badFormat, 400, 'bad_request', 'disallowed_format');
    pushPass(tests, 'file_size_and_format_rejections');

    const native = await api(request, '/api/v1/native/session', {
      method: 'POST',
      origin: null,
      body: { serverId: 'dev-a', username: 'alice', password: 'dev-only' },
    });
    checkStatus(native, 201, 'native_session');
    const nativeData = jsonBody(native)?.data;
    const setCookie = native.headers['set-cookie'];
    assert(
      !setCookie && typeof nativeData?.credential === 'string',
      'native_session',
      'native_cookie_or_missing_bearer',
    );
    const bearerMe = await api(request, '/api/v1/me', {
      bearer: nativeData.credential,
    });
    checkStatus(bearerMe, 200, 'native_bearer');
    const mixedProof = await api(request, '/api/v1/me', {
      bearer: nativeData.credential,
      cookie: alice.cookie,
    });
    checkErrorCode(mixedProof, 401, 'unauthorized', 'native_bearer_isolation');
    const nativeLoginWithCookie = await api(request, '/api/v1/native/session', {
      method: 'POST',
      cookie: alice.cookie,
      origin: null,
      body: { serverId: 'dev-a', username: 'alice', password: 'dev-only' },
    });
    checkErrorCode(
      nativeLoginWithCookie,
      401,
      'unauthorized',
      'native_cookie_isolation',
    );
    pushPass(tests, 'native_bearer_isolation');

    if (options.origin.startsWith('https:')) {
      const tlsRejections = await verifyTlsRejections(input);
      tests.push(...tlsRejections.tests);
    }

    fixture.aliceUserId = alice.user.id;
    fixture.verificationId = options.tag;
    return {
      verificationId: options.tag,
      counts: resultSummary(tests),
      tests,
      fixture,
    };
  } catch (error) {
    const test = error?.test ?? 'transport';
    const code = error?.code ?? 'unexpected_failure';
    tests.push({ name: test, passed: false, code });
    return {
      verificationId: options.tag,
      counts: resultSummary(tests),
      tests,
      fixture,
      passed: false,
    };
  }
}

export async function recheckPersistedFixture(input) {
  const options = normalizeOptions(input);
  const fixture = input.fixture;
  if (!fixture?.groupConversationId || !fixture?.groupMessageId)
    throw new TypeError(
      'fixture must contain group conversation and message identifiers',
    );
  const request = await makeTransport(options);
  try {
    const alice = await login(request, 'alice', 'dev-a', {
      origin: options.origin,
    });
    const messages = await api(
      request,
      `/api/v1/conversations/${fixture.groupConversationId}/messages?limit=100`,
      { cookie: alice.cookie },
    );
    checkStatus(messages, 200, 'restart_messages');
    assert(
      jsonBody(messages)?.data?.some(
        (item) => item.id === fixture.groupMessageId,
      ),
      'restart_messages',
      'committed_message_missing',
    );
    const exactFile = await api(
      request,
      `/api/v1/files/${fixture.exactFileId}/content`,
      { cookie: alice.cookie },
    );
    checkStatus(exactFile, 200, 'restart_attachment');
    assert(
      exactFile.bytes.length === FILE_LIMIT &&
        exactFile.bytes.every((byte) => byte === 0x61),
      'restart_attachment',
      'attachment_bytes_changed',
    );
    const tests = [{ name: 'persisted_message_and_attachment', passed: true }];
    return {
      verificationId: fixture.verificationId,
      counts: resultSummary(tests),
      tests,
      fixture: {
        groupConversationId: fixture.groupConversationId,
        groupMessageId: fixture.groupMessageId,
        exactFileId: fixture.exactFileId,
      },
    };
  } catch (error) {
    const tests = [
      {
        name: error?.test ?? 'transport',
        passed: false,
        code: error?.code ?? 'unexpected_failure',
      },
    ];
    return {
      verificationId: fixture.verificationId,
      counts: resultSummary(tests),
      tests,
      fixture: {
        groupConversationId: fixture.groupConversationId,
        groupMessageId: fixture.groupMessageId,
        exactFileId: fixture.exactFileId,
      },
      passed: false,
    };
  }
}

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--base-url', '--ca', '--tag'].includes(name) || !argv[index + 1])
      throw new TypeError('expected --base-url URL [--ca FILE] [--tag ID]');
    args[
      { '--base-url': 'baseURL', '--ca': 'trustedCA', '--tag': 'tag' }[name]
    ] = argv[++index];
  }
  return args;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let result;
  try {
    result = await runVmVerification(readArgs(process.argv.slice(2)));
  } catch {
    result = {
      passed: false,
      tests: [{ name: 'input', passed: false, code: 'invalid_input' }],
    };
  }
  process.stdout.write(
    `${JSON.stringify({
      verificationId: result.verificationId,
      counts: result.counts,
      tests: result.tests,
      passed: result.passed ?? result.tests.every((test) => test.passed),
    })}\n`,
  );
  if (!result.tests.every((test) => test.passed)) process.exitCode = 1;
}
