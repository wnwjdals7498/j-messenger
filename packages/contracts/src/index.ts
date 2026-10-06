export * from './schema.js';
export * from './ports.js';
export * from './logging.js';

/** API v1 routes and request/response schema references used by HTTP/OpenAPI adapters. */
export const API_V1 = {
  basePath: '/api/v1',
  requestIdHeader: 'X-Request-Id',
  routes: {
    createSession: {
      method: 'POST',
      path: '/session',
      success: 201,
      unauthorized: 401,
    },
    me: { method: 'GET', path: '/me', success: 200, unauthorized: 401 },
    deleteSession: {
      method: 'DELETE',
      path: '/session',
      success: 200,
      unauthorized: 401,
    },
    listUsers: {
      method: 'GET',
      path: '/users',
      success: 200,
      unauthorized: 401,
    },
    listConversations: {
      method: 'GET',
      path: '/conversations',
      success: 200,
      unauthorized: 401,
    },
    createConversation: {
      method: 'POST',
      path: '/conversations',
      success: 201,
      unauthorized: 401,
    },
    listMessages: {
      method: 'GET',
      path: '/conversations/:id/messages',
      success: 200,
      unauthorized: 401,
    },
    createMessage: {
      method: 'POST',
      path: '/conversations/:id/messages',
      success: 201,
      unauthorized: 401,
    },
    sync: {
      method: 'GET',
      path: '/sync',
      success: 200,
      unauthorized: 401,
      expiredCursor: 410,
    },
    uploadFile: {
      method: 'POST',
      path: '/conversations/:id/files',
      success: 201,
      tooLarge: 413,
    },
    downloadFile: {
      method: 'GET',
      path: '/files/:id/content',
      success: 200,
      unauthorized: 401,
    },
    advanceRead: {
      method: 'PUT',
      path: '/conversations/:id/read',
      success: 200,
      unauthorized: 401,
    },
  },
} as const;
