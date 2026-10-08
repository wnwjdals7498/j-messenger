import { randomUUID } from 'node:crypto';
import type { SystemContext, Uuid } from '@j-messenger/contracts';
import type { createApplication } from './application.js';

type Application = Awaited<ReturnType<typeof createApplication>>;

/** For an offline application built with maintenance:false; never opens a transport. */
export async function postgresBackupReferences(application: Application) {
  if (application.app.server.listening || application.db.kind !== 'postgres')
    throw new Error('PostgreSQL recovery requires a stopped public transport');
  const files = await application.files.listBackupReferences();
  await application.messages.verifyAttachmentReferences(files);
  return files;
}

/** Re-applies existing policy through owners before a caller may reopen traffic. */
export async function finalizePostgresRecovery(application: Application) {
  if (application.app.server.listening || application.db.kind !== 'postgres')
    throw new Error('PostgreSQL recovery requires a stopped public transport');
  await postgresBackupReferences(application);
  for (const server of application.identity.listServers()) {
    const context: SystemContext = {
      serverId: server.id,
      requestId: randomUUID() as Uuid,
    };
    await application.retention.applyCurrentPolicy(context);
    let complete = false;
    for (let batch = 0; batch < 10000; batch++) {
      const result = await application.retention.runSystemBatch(context, 100);
      if (result.complete) {
        complete = true;
        break;
      }
      if (result.messages + result.files === 0)
        throw new Error('Recovery retention made no progress');
    }
    if (!complete) throw new Error('Recovery retention batch limit reached');
  }
  await application.identity.revokeAllSessions();
  let drained = false;
  for (let batch = 0; batch < 10000; batch++) {
    const result = await application.runner.runBatch(100);
    if (result.retried || result.failed)
      throw new Error('Recovery file deletion is incomplete');
    if (result.completed === 0) {
      drained = true;
      break;
    }
  }
  if (!drained) throw new Error('Recovery job batch limit reached');
  const files = await postgresBackupReferences(application);
  if (files.some((file) => file.state === 'deleting'))
    throw new Error('Recovery has outstanding file deletions');
  await application.db.run((tx) => application.db.rotateStreamEpoch(tx));
  return { currentPolicyApplied: true, sessionsRevoked: true } as const;
}
