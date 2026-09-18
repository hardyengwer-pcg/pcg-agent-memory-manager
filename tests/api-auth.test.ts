import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiAuthMiddleware } from '../src/server/api-auth.ts';

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

test('rejects API requests without bearer token', async () => {
  const middleware = createApiAuthMiddleware({ validateGoogleToken: async () => assert.fail('must not validate') });
  const response = makeResponse();
  let called = false;

  await middleware({ method: 'POST', path: '/actions/task', headers: {} } as any, response as any, () => { called = true; });

  assert.equal(response.statusCode, 401);
  assert.equal(called, false);
});

test('allows masked AI settings read without authentication', async () => {
  const middleware = createApiAuthMiddleware({ validateGoogleToken: async () => assert.fail('must not validate') });
  const response = makeResponse();
  let called = false;

  await middleware({ method: 'GET', path: '/ai-settings', headers: {} } as any, response as any, () => { called = true; });

  assert.equal(response.statusCode, 200);
  assert.equal(called, true);
});

test('maps a rejected Google account to 403', async () => {
  const middleware = createApiAuthMiddleware({ validateGoogleToken: async () => { throw Object.assign(new Error('ACCOUNT_NOT_ALLOWED'), { status: 403 }); } });
  const response = makeResponse();

  await middleware({ method: 'GET', path: '/tasks', headers: { authorization: 'Bearer token' } } as any, response as any, () => {});

  assert.equal(response.statusCode, 403);
});

test('passes the validated token to the request', async () => {
  const middleware = createApiAuthMiddleware({ validateGoogleToken: async (token) => assert.equal(token, 'valid-token') });
  const response = makeResponse();
  const request: any = { method: 'GET', path: '/tasks', headers: { authorization: 'Bearer valid-token' } };
  let called = false;

  await middleware(request, response as any, () => { called = true; });

  assert.equal(called, true);
  assert.equal(request.googleToken, 'valid-token');
});
