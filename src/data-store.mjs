import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname,basename,isAbsolute } from 'node:path';
import {recordDiagnostic,diagnosticId,diagnosticCode} from './diagnostics.mjs';
import { randomUUID } from 'node:crypto';

const parse = row => row ? JSON.parse(row.value_json) : null;
const copy = value => JSON.parse(JSON.stringify(value));
export const initialSettings = Object.freeze({provider:'cli',cli_path:'',deepseek_model:'deepseek-flash',commute_mode:'off',commute_enabled_mode:'calculate_only',reference:'',message_max_chars:60,weekly_cleanup:false});
export const initialProfile = Object.freeze({resume_file:'',resume_name:'',resume_text:'',supplement:'',introduction:'',conditions:'',facts:[]});

// The six business tables store complete records; model work never holds a transaction.
export class JobmateStore {
  constructor(path) {
    this.path=path;this.diagnosticRoot=isAbsolute(path)?(basename(dirname(path))==='data'?dirname(dirname(path)):dirname(path)):null;
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value_json TEXT NOT NULL)');
    for (const table of ['expectations','jobs','workflow_tasks','batches','cases']) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,expectation_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,value_json TEXT NOT NULL)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_expectation ON ${table}(expectation_id)`);
    }
    if (!this.getSetting('settings')) this.setSetting('settings',initialSettings);
    if (!this.getSetting('profile')) this.setProfile(initialProfile);
    if (!this.getSetting('onboarding')) this.setSetting('onboarding',{step:1,complete:false,draft:{...initialProfile,reference:'你好，我有XXXX，期待沟通'}});
  }
  close() { this.db.close(); }
  transaction(fn) {
    if (this._transactionActive) return fn();
    let phase='transaction.begin',rolledBack=false;
    try {
      this.db.exec('BEGIN IMMEDIATE');this._transactionActive=true;
      try {phase='transaction.body';const value=fn();if(value?.then)throw new Error('事务中不能等待外部处理');phase='transaction.commit';this.db.exec('COMMIT');return value;}
      catch(error){this.db.exec('ROLLBACK');rolledBack=true;throw error;}
      finally{this._transactionActive=false;}
    }catch(error){
      if(this.diagnosticRoot)void recordDiagnostic(this.diagnosticRoot,{component:'database',operation:'transaction',phase,outcome:'error',rollback_complete:rolledBack,error_code:diagnosticCode(error),sqlite_code:Number.isInteger(error.errcode)?error.errcode:null});
      throw error;
    }
  }

  getSetting(key,fallback=null) { return parse(this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key)) ?? copy(fallback); }
  setSetting(key,value) { this.db.prepare('INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,JSON.stringify(value)); return copy(value); }
  getProfile() { return this.getSetting('profile',initialProfile); }
  setProfile(value) { return this.setSetting('profile',value); }
  reset() {
    this.db.exec('PRAGMA secure_delete=ON');
    this.transaction(()=>{
      for(const table of ['settings','expectations','jobs','workflow_tasks','batches','cases'])this.db.exec(`DELETE FROM ${table}`);
      this.setSetting('settings',initialSettings);this.setProfile(initialProfile);
      this.setSetting('onboarding',{step:1,complete:false,draft:{...initialProfile,reference:'你好，我有XXXX，期待沟通'}});
    });
    this.db.exec('VACUUM');
    const checkpoint=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(checkpoint.busy)throw new Error('数据库仍被其他进程占用，请关闭占用后重试清理');
  }
  _list(table,expectationId) { return this.db.prepare(`SELECT value_json FROM ${table}${expectationId ? ' WHERE expectation_id=?':''} ORDER BY created_at,rowid`).all(...(expectationId ? [expectationId]:[])).map(parse); }
  _get(table,id) { return parse(this.db.prepare(`SELECT value_json FROM ${table} WHERE id=?`).get(id)); }
  _save(table,value) {
    const now=new Date().toISOString();
    const previous=value.id ? this._get(table,value.id):null;
    const result={...value,id:value.id || randomUUID(),created_at:value.created_at || previous?.created_at || now,updated_at:now};
    this.db.prepare(`INSERT INTO ${table}(id,expectation_id,created_at,updated_at,value_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expectation_id=excluded.expectation_id,updated_at=excluded.updated_at,value_json=excluded.value_json`).run(result.id,result.expectation_id || null,result.created_at,result.updated_at,JSON.stringify(result));
    return copy(result);
  }
  _delete(table,id) { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  listExpectations() { return this._list('expectations'); }
  getExpectation(id) { return this._get('expectations',id); }
  saveExpectation(value) { return this._save('expectations',value); }
  listJobs(id) { return this._list('jobs',id); }
  getJob(id) { return this._get('jobs',id); }
  saveJob(value) { return this._save('jobs',value); }
  deleteJob(id) { return this._delete('jobs',id); }
  listTasks(id) { return this._list('workflow_tasks',id); }
  getTask(id) { return this._get('workflow_tasks',id); }
  saveTask(value) { return this._save('workflow_tasks',value); }
  deleteTask(id) { return this._delete('workflow_tasks',id); }
  listBatches(id) { return this._list('batches',id); }
  getBatch(id) { return this._get('batches',id); }
  saveBatch(value) { return this._save('batches',value); }
  deleteBatch(id) { return this._delete('batches',id); }
  listCases() { return this._list('cases'); }
  saveCase(value) { return this._save('cases',value); }
  refreshExpectations(items) {
    if (!Array.isArray(items) || !items.length || items.some(item=>!item.title?.trim() || !item.city?.trim())) throw new Error('未读取到有效求职期望，原期望保持');
    return this.transaction(()=>items.map(item=>{
      const found=this.listExpectations().find(old=>old.title===item.title.trim() && old.city===item.city.trim());
      return this.saveExpectation({...found,title:item.title.trim(),city:item.city.trim(),source_id:item.source_id || found?.source_id,origins:found?.origins || []});
    }));
  }
  deleteExpectation(id) {
    return this.transaction(()=>{
      if (!this.getExpectation(id)) throw new Error('求职期望不存在');
      if (this.listExpectations().length<=1) throw new Error('至少保留一个求职期望');
      for (const table of ['jobs','workflow_tasks','batches']) this.db.prepare(`DELETE FROM ${table} WHERE expectation_id=?`).run(id);
      this._delete('expectations',id);
      const drafts=this.getSetting('taskDrafts',{}); delete drafts[id]; this.setSetting('taskDrafts',drafts);
      this.db.prepare('DELETE FROM settings WHERE key=?').run(`mapPlaces:${id}`);
      for (const key of ['settingsDraft','profile','profileDraft']) {
        const value=this.getSetting(key);
        if (value?.origin_drafts && Object.hasOwn(value.origin_drafts,id)) {delete value.origin_drafts[id];this.setSetting(key,value);}
      }
      const onboarding=this.getSetting('onboarding');
      if (onboarding.draft?.origin_drafts && Object.hasOwn(onboarding.draft.origin_drafts,id)) {delete onboarding.draft.origin_drafts[id];this.setSetting('onboarding',onboarding);}
      for (const task of this.listTasks().filter(task=>task.result?.expectations?.some(e=>e.id===id))) {
        task.result.expectations=task.result.expectations.filter(e=>e.id!==id);this.saveTask(task);
      }
    });
  }
  recoverInterrupted() {
    const week=this.getSetting('weekCleanup',{});
    if(['waiting','running'].includes(week.status))this.setSetting('weekCleanup',{...week,status:'failed',error:'每周清理已中断，请在原页面重试'});
    for (const task of this.listTasks().filter(task=>['queued','running'].includes(task.status))) {
      if(task.kind==='jobs')for(const stage of ['screening','batch']){
        if(task.result?.[stage]?.status==='running')task.result[stage].status='failed';
      }
      if (task.kind==='profile' && !task.result?.updated && task.input?.mode!=='introduction') task.result={};
      if(task.kind==='initialization'){
        const onboarding=this.getSetting('onboarding');
        if(onboarding.example?.status==='running'){onboarding.example.status='failed';onboarding.example.error='示例生成已中断，可手动重试；个人介绍已保留。';this.setSetting('onboarding',onboarding);}
      }
      if(this.diagnosticRoot)void recordDiagnostic(this.diagnosticRoot,{component:'runtime',operation:'recover.task',phase:'recover.interrupted',task_id:diagnosticId(task.id),kind:['jobs','profile','initialization','expectations','agent_test','review','delivery','verification','introduction_tool','introduction_preview'].includes(task.kind)?task.kind:null,previous_status:task.status,stop_requested:!!task.stop_requested,previous_stage:['读取简历正文','生成个人介绍','批量采集岗位','完整JD读取','岗位评估','发起沟通','发送已确认消息','聊天批次定位'].includes(task.result?.stage)?task.result.stage:null,outcome:'interrupted',reason:'prior_process_ended_unknown'},()=>this.getSetting('secrets',{}));
      task.status='failed'; task.error='后台已中断，请在原页面手动重试';
      this.saveTask(task);
    }
    for (const batch of this.listBatches()) {
      let changed=false;
      for (const entry of batch.jobs || []) {
        if (['queued','running'].includes(entry.review?.pending?.status)) {entry.review.pending.status='failed';entry.review.pending.error='后台已中断，请重试或放弃本次修改';changed=true;}
        if (entry.delivery_status==='sending') {entry.delivery_status='uncertain';entry.last_error='发送结果需核实，不能直接重发';changed=true;}
        if (entry.delivery_inflight) {entry.last_error=entry.delivery_inflight==='greeting'?'greeting_outcome_unknown':'chat_send_outcome_unknown';entry.delivery_inflight=null;changed=true;}
      }
      if(changed){this.saveBatch(batch);if(this.diagnosticRoot)void recordDiagnostic(this.diagnosticRoot,{component:'runtime',operation:'recover.batch',phase:'recover.interrupted',batch_id:diagnosticId(batch.id),outcome:'interrupted',reason:'prior_process_ended_unknown'},()=>this.getSetting('secrets',{}));}
    }
  }
}
