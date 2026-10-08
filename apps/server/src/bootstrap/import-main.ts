import path from 'node:path';
import { PostgresStorage } from '../platform/storage/postgres.js';
import { importSqlite } from './import-sqlite.js';

let target: PostgresStorage | undefined;
try {
  const source = process.env['JMS_SQLITE_IMPORT_SOURCE'];
  const value = process.env['DATABASE_URL'];
  const url = new URL(value ?? '');
  const schema = process.env['DATABASE_SCHEMA'] ?? 'public';
  if (
    !source ||
    !path.isAbsolute(source) ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/jgw_messenger' ||
    url.port === '3001' ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash
  )
    throw new Error();
  target = await PostgresStorage.open({ connectionString: value!, schema });
  const result = await importSqlite(source, target);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write(
    'SQLite 이관 실패: 원본을 보존했습니다. 대상·원본 스키마와 비어 있는 대상 조건을 확인하세요.\n',
  );
  process.exitCode = 1;
} finally {
  await target?.close();
}
