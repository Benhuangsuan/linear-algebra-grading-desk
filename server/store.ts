import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Assignment, Course, StoredFile, Submission, History, State } from '../shared/domain.js';

type Entity = Course | Assignment | StoredFile | Submission | History;
type AiTable='ai_batches'|'ai_calls'|'ai_cache'|'reference_tasks'|'reference_results'|'reference_responses';
type Table = 'courses'|'assignments'|'files'|'submissions'|'history'|'versions'|AiTable;
export class Store {
  private transactionDepth=0;
  putAi<T extends {id:string}>(table:AiTable,entity:T) {
    this.db.prepare('INSERT INTO '+table+' (id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(entity.id,JSON.stringify(entity));
  }
  readonly db: DatabaseSync;
  readonly uploads: string;
  constructor(readonly dir: string) {
    mkdirSync(dir,{recursive:true});
    this.uploads=join(dir,'uploads'); mkdirSync(this.uploads,{recursive:true});
    this.db=new DatabaseSync(join(dir,'grading.sqlite'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS files_assignment ON files(assignment_id);
      CREATE INDEX IF NOT EXISTS submissions_assignment ON submissions(assignment_id);
      CREATE INDEX IF NOT EXISTS history_submission ON history(submission_id);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS ai_batches(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ai_cache(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reference_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS reference_results(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reference_responses(id TEXT PRIMARY KEY,payload TEXT NOT NULL);');
    for (const s of this.all<Submission>('submissions').filter(s=>['queued','processing'].includes(s.status))) {
      this.put('submissions',{...s,status:'failed',error:'上次退出时任务未完成，可单独重试。',revision:s.revision+1});
    }
  }
  all<T>(table:Table):T[] { return this.db.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all().map(row=>JSON.parse(String(row.payload)) as T); }
  get<T>(table:Table,id:string):T|undefined { const row=this.db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id); return row?JSON.parse(String(row.payload)) as T:undefined; }
  put(table:Table,entity:Entity|{id:string;assignmentId:string;[key:string]:unknown}) {
    const cols=['id','payload']; const vals=[entity.id,JSON.stringify(entity)];
    if ('courseId' in entity) {cols.push('course_id'); vals.push(String(entity.courseId));}
    if ('assignmentId' in entity) {cols.push('assignment_id'); vals.push(String(entity.assignmentId));}
    if (table==='submissions' && 'fileId' in entity) {cols.push('file_id'); vals.push(String(entity.fileId));}
    if (table==='history' && 'submissionId' in entity) {cols.push('submission_id'); vals.push(String(entity.submissionId));}
    this.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(...vals);
  }
  delete(table:Table,id:string) { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  transaction<T>(fn:()=>T):T {if(this.transactionDepth)return fn();this.db.exec('BEGIN IMMEDIATE');this.transactionDepth++;try {const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.transactionDepth--;}}
  history(s:Submission,action:string) {this.put('history',{id:randomUUID(),submissionId:s.id,action,at:new Date().toISOString(),snapshot:s});}
  state():State {return {courses:this.all('courses'),assignments:this.all('assignments'),files:this.all('files'),submissions:this.all('submissions'),provider:'mock'};}
  close(){this.db.close();}
}
