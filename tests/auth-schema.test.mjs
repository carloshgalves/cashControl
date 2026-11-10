import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const migration=name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');

test('auth and finance D1 migrations create constrained auth tables',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(migration('0001_financial_accounts.sql'));
    db.exec(migration('0002_better_auth.sql'));
    db.exec(migration('0003_cash_movements.sql'));
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    for(const name of ['user','session','account','verification','rateLimit','financial_accounts','initial_allocations'])assert(tables.includes(name),name);
    db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run('test-user','Test','test@example.test',0,1,1);
    assert.throws(()=>db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run('other','Test 2','test@example.test',0,1,1),/UNIQUE/);
    db.prepare('INSERT INTO "session" (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)')
      .run('s1',2000000000000,'token-1',1,1,'test-user');
    assert.throws(()=>db.prepare('INSERT INTO "session" (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)')
      .run('s2',2000000000000,'token-2',1,1,'missing-user'),/FOREIGN KEY/);
    db.prepare('DELETE FROM "user" WHERE id = ?').run('test-user');
    assert.equal(db.prepare('SELECT count(*) as total FROM "session"').get().total,0);
  } finally {db.close();}
});
