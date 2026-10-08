import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import {
  DomainError,
  type FeatureLog,
  type RequestContext,
  type SessionResolver,
} from '@j-messenger/contracts';
import { loadConfig } from '../../src/platform/config/index.js';
import {
  createHttpServer,
  registerHttpRoutes,
  requireContext,
  routeConfig,
} from '../../src/platform/http/index.js';

const ctx: RequestContext = {
  serverId: 'dev-a',
  userId: '1',
  sessionId: '2',
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  authenticatedAt: '2026-10-02T00:00:00.000Z',
};
function fixture(
  authMode: 'development-fixed' | 'j-auth' = 'development-fixed',
) {
  let calls = 0;
  let handlers = 0;
  const events: unknown[] = [];
  const resolver: SessionResolver = {
    async resolve({ credential }) {
      calls++;
      if (credential === 'bad') throw new DomainError('unauthorized');
      return ctx;
    },
  };
  const logger: FeatureLog = {
    emit(event) {
      events.push(event);
    },
    afterCommit() {
      throw new Error('unused');
    },
  };
  const app = createHttpServer({
    config: loadConfig({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
      ...(authMode === 'j-auth'
        ? {
            AUTH_MODE: 'j-auth',
            JAUTH_TENANT: 'tenant-test',
            KC_PUBLIC_URL: 'https://kc.jgw.test',
          }
        : {}),
    }),
    resolver,
    logger,
  });
  registerHttpRoutes(app, (routes) => {
    routes.route({
      method: 'GET',
      url: '/private/:id',
      config: routeConfig('authRequired'),
      handler: async (request) => {
        handlers++;
        return { data: requireContext(request) };
      },
    });
    routes.route({
      method: 'GET',
      url: '/native',
      config: routeConfig('native'),
      handler: async (request) => {
        handlers++;
        return { data: requireContext(request) };
      },
    });
    routes.get(
      '/socket',
      { config: routeConfig('authRequired'), websocket: true },
      () => {
        handlers++;
      },
    );
    routes.get(
      '/bearer-socket',
      { config: routeConfig('authRequired'), websocket: true },
      () => {
        handlers++;
      },
    );
    routes.get(
      '/native-socket',
      { config: routeConfig('native'), websocket: true },
      () => {
        handlers++;
      },
    );
    routes.route({
      method: 'GET',
      url: '/page',
      config: routeConfig('public'),
      schema: {
        querystring: Type.Object(
          { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
          { additionalProperties: false },
        ),
      },
      handler: async (request) => ({ data: request.query }),
    });
    routes.route({
      method: 'POST',
      url: '/public/login',
      config: routeConfig('public'),
      handler: async () => ({ data: true }),
    });
    routes.route({
      method: 'GET',
      url: '/health/live',
      config: routeConfig('public'),
      handler: async () => ({ data: { live: true } }),
    });
    routes.route({
      method: 'POST',
      url: '/native/session',
      config: routeConfig('public', { credentialSubmission: 'native' }),
      handler: async () => ({ data: true }),
    });
    routes.route({
      method: 'POST',
      url: '/change',
      config: routeConfig('authRequired'),
      schema: {
        body: Type.Object(
          { count: Type.Integer() },
          { additionalProperties: false },
        ),
      },
      handler: async (request) => ({ data: request.body }),
    });
    routes.route({
      method: 'POST',
      url: '/body-id',
      config: routeConfig('public'),
      schema: {
        body: Type.Object(
          { id: Type.String({ pattern: '^[1-9][0-9]*$' }) },
          { additionalProperties: false },
        ),
      },
      handler: async (request) => ({ data: request.body }),
    });
    routes.route({
      method: 'GET',
      url: '/failure',
      config: routeConfig('public'),
      handler: async () => {
        throw new Error('secret failure detail');
      },
    });
  });
  return {
    app,
    get calls() {
      return calls;
    },
    get handlers() {
      return handlers;
    },
    events,
  };
}

describe('HTTP boundary', () => {
  it('ignores supplied request IDs and logs only the route template', async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: 'GET',
      url: '/private/123?secret=query-secret',
      headers: { cookie: 'jm_session=opaque', 'x-request-id': 'caller-value' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers['x-request-id']).not.toBe('caller-value');
    expect(f.calls).toBe(1);
    expect(f.handlers).toBe(1);
    expect(JSON.stringify(f.events)).toContain('"route":"/private/:id"');
    expect(JSON.stringify(f.events)).not.toContain('query-secret');
    expect(JSON.stringify(f.events)).not.toContain('/private/123');
    await f.app.close();
  });

  it('rejects missing/foreign origins and cookie plus bearer before handlers', async () => {
    const f = fixture();
    const missing = await f.app.inject({
      method: 'POST',
      url: '/change',
      headers: { cookie: 'jm_session=secret' },
      payload: { count: 1 },
    });
    const foreign = await f.app.inject({
      method: 'POST',
      url: '/change',
      headers: {
        origin: 'https://attacker.invalid',
        cookie: 'jm_session=secret',
      },
      payload: { count: 1 },
    });
    const both = await f.app.inject({
      method: 'POST',
      url: '/change',
      headers: {
        origin: 'http://127.0.0.1:3000',
        cookie: 'jm_session=secret',
        authorization: 'Bearer other-secret',
      },
      payload: { count: 1 },
    });
    expect(missing.statusCode).toBe(403);
    expect(foreign.statusCode).toBe(403);
    expect(both.statusCode).toBe(401);
    expect(f.calls).toBe(0);
    await f.app.close();
  });

  it('accepts bearer only on the native policy and rejects native cookie proof', async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: 'GET',
      url: '/native',
      headers: { authorization: 'Bearer native-token' },
    });
    expect(response.statusCode).toBe(200);
    const cookieAttempt = await f.app.inject({
      method: 'GET',
      url: '/native',
      headers: { cookie: 'jm_session=secret' },
    });
    expect(cookieAttempt.statusCode).toBe(401);
    expect(f.calls).toBe(1);
    await f.app.close();
  });

  it('resolves protected proof before business handlers and supports bearer auth on shared routes', async () => {
    const f = fixture();
    expect(
      (await f.app.inject({ method: 'GET', url: '/private/1' })).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/private/1',
          headers: { authorization: 'Basic wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/private/1',
          headers: { authorization: 'Bearer bad' },
        })
      ).statusCode,
    ).toBe(401);
    expect(f.calls).toBe(1);
    expect(f.handlers).toBe(0);
    const bearer = await f.app.inject({
      method: 'POST',
      url: '/change',
      headers: { authorization: 'Bearer valid' },
      payload: { count: 1 },
    });
    expect(bearer.statusCode).toBe(200);
    expect(f.calls).toBe(2);
    await f.app.close();
  });

  it('requires a bearer token for j-auth protected HTTP and leaves public health available', async () => {
    const f = fixture('j-auth');
    const cookieOnly = await f.app.inject({
      method: 'GET',
      url: '/private/1',
      headers: { cookie: 'jm_session=legacy-session' },
    });
    const mixed = await f.app.inject({
      method: 'GET',
      url: '/private/1',
      headers: {
        authorization: 'Bearer token',
        cookie: 'jm_session=legacy-session',
      },
    });
    const queryToken = await f.app.inject({
      method: 'GET',
      url: '/private/1?access_token=token',
      headers: { authorization: 'Bearer token' },
    });
    const validBearer = await f.app.inject({
      method: 'GET',
      url: '/private/1',
      headers: { authorization: 'Bearer valid' },
    });
    const health = await f.app.inject({ method: 'GET', url: '/health/live' });
    expect(cookieOnly.statusCode).toBe(401);
    expect(mixed.statusCode).toBe(401);
    expect(queryToken.statusCode).toBe(401);
    expect(validBearer.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
    expect(f.calls).toBe(1);
    expect(f.handlers).toBe(1);
    await f.app.close();
  });

  it('permits native bearer WebSocket without Origin and requires exact Origin for cookie WebSocket', async () => {
    const f = fixture();
    await f.app.ready();
    const native = await f.app.injectWS('/native-socket', {
      headers: { authorization: 'Bearer native-token' },
    });
    native.terminate();
    expect(f.handlers).toBe(1);
    const bearer = await f.app.injectWS('/bearer-socket', {
      headers: { authorization: 'Bearer windows-token' },
    });
    bearer.terminate();
    expect(f.handlers).toBe(2);
    await expect(
      f.app.injectWS('/socket', {
        headers: { cookie: 'jm_session=browser-token' },
      }),
    ).rejects.toThrow('403');
    expect(f.handlers).toBe(2);
    expect(f.calls).toBe(2);
    native.close();
    bearer.close();
  });

  it('applies j-auth bearer-only proof to protected WebSocket handshakes', async () => {
    const f = fixture('j-auth');
    await f.app.ready();
    await expect(
      f.app.injectWS('/bearer-socket', {
        headers: { cookie: 'jm_session=legacy-session' },
      }),
    ).rejects.toThrow('401');
    await expect(
      f.app.injectWS('/bearer-socket?token=secret', {
        headers: { authorization: 'Bearer token' },
      }),
    ).rejects.toThrow('401');
    const bearer = await f.app.injectWS('/bearer-socket', {
      headers: { authorization: 'Bearer token' },
    });
    bearer.terminate();
    expect(f.calls).toBe(1);
    expect(f.handlers).toBe(1);
    bearer.close();
    await f.app.close();
  });

  it('requires Origin for browser login, allows native session issuance, and rejects extra body fields', async () => {
    const f = fixture();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/public/login',
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/public/login',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/native/session',
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/native/session',
          headers: { cookie: 'jm_session=browser-proof' },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/change',
      headers: { origin: 'http://127.0.0.1:3000', cookie: 'jm_session=secret' },
      payload: { count: 1, extra: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('bad_request');
    expect(f.calls).toBe(0);
    await f.app.close();
  });

  it('converts query limits only while keeping body values uncoerced', async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: 'GET',
      url: '/page?limit=50',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.limit).toBe(50);
    await f.app.close();
  });

  it('preserves large decimal IDs as strings and rejects numeric IDs', async () => {
    const f = fixture();
    const headers = { origin: 'http://127.0.0.1:3000' };
    const valid = await f.app.inject({
      method: 'POST',
      url: '/body-id',
      headers,
      payload: { id: '9007199254740993' },
    });
    const roundedNumber = await f.app.inject({
      method: 'POST',
      url: '/body-id',
      headers,
      payload: { id: 9007199254740993 },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().data.id).toBe('9007199254740993');
    expect(roundedNumber.statusCode).toBe(400);
    await f.app.close();
  });

  it('returns safe oversized-body errors and logs only safe metadata', async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: '/change',
      headers: { origin: 'http://127.0.0.1:3000', cookie: 'jm_session=secret' },
      payload: { count: 1, padding: 'x'.repeat(65_536) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.message).not.toContain('padding');
    expect(JSON.stringify(f.events)).not.toMatch(/secret|padding|x{10}/);
    await f.app.close();
  });

  it('hides unexpected exception details in the standard error envelope', async () => {
    const f = fixture();
    const response = await f.app.inject({ method: 'GET', url: '/failure' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('internal');
    expect(JSON.stringify(response.json())).not.toContain(
      'secret failure detail',
    );
    await f.app.close();
  });

  it('limits requests to 100 per minute and uses a safe not-found envelope', async () => {
    const f = fixture();
    const responses = await Promise.all(
      Array.from({ length: 101 }, () =>
        f.app.inject({ method: 'GET', url: '/page' }),
      ),
    );
    const limited = responses.find((response) => response.statusCode === 429);
    expect(limited).toBeDefined();
    expect(limited?.json().error.code).toBe('rate_limited');
    const missing = await f.app.inject({
      method: 'GET',
      url: '/no-such-route?secret=not-logged',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    expect(JSON.stringify(missing.json())).not.toContain('secret');
    await f.app.close();
  });
});
