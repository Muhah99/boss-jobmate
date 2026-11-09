import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { detailUrl } from './external-services.mjs';
import {createReviewLearning} from './review-learning.mjs';

const now = () => new Date().toISOString();
const copy = value => structuredClone(value);
const FINAL_DELIVERY = new Set(['message_sent', 'already_contacted', 'headhunter_skipped', 'job_closed', 'not_delivering']);
const PAUSE=Symbol('review.pause');
const UNCERTAIN = new Set(['chat_send_outcome_unknown', 'sent_message_not_visible', 'greeting_outcome_unknown']);

export function createReviewWorkflows({ store, agent, external, progress }) {
  const runners = new Map();
  const learning=createReviewLearning({store,agent,progress,runners});
  const deliverySignals = new Map();
  const verificationSignals = new Map();
  function get(batchId, expectationId) {
    const batch = store.getBatch(batchId);
    if (!batch || expectationId && batch.expectation_id !== expectationId) throw new Error('投递安排不属于当前求职期望。');
    return batch;
  }
  function editable(batchId) {
    const batch = get(batchId);
    if (batch.status !== 'reviewing') throw new Error('本次投递已完成审阅，不能继续修改。');
    for(const item of batch.jobs)if(item.choice==null)item.choice='deliver';
    if(store.listTasks().some(t=>t.kind==='profile' && ['queued','running'].includes(t.status)))throw new Error('个人资料正在更新，原投递安排暂不可修改');
    const weekly = store.getSetting('weekCleanup', {});
    if (['running', 'failed', 'waiting'].includes(weekly.status)) throw new Error('请先完成本周清理。');
    return batch;
  }
  const save = batch => store.saveBatch({ ...batch, updated_at: now() });
  function record(batch, jobId) {
    const item = batch.jobs.find(job => job.job_id === jobId);
    if (!item) throw new Error('岗位不在当前投递安排中。');
    item.review ||= { feedback: {}, pending: null, draft: null };
    return item;
  }
  const current = item => item.review?.draft || { message: item.message, mappings: item.mappings, sources: item.sources,
    ...(Object.hasOwn(item, 'jd_basis') ? { jd_basis: item.jd_basis } : {}),
    ...(Object.hasOwn(item, 'tags_basis') ? { tags_basis: item.tags_basis } : {}) };
  function voidReason(batch) {
    if(batch.status==='voided')return '此投递安排已作废。';
    if(batch.status!=='reviewing')return '本次投递已完成审阅，不能作废。';
    const tasks=store.listTasks(),ids=new Set(batch.jobs.map(item=>item.job_id));
    if(tasks.some(t=>['delivery','verification'].includes(t.kind)&&t.input?.batch_id===batch.id)
      ||batch.jobs.some(item=>!['prepared','not_delivering'].includes(item.delivery_status)||item.delivery_inflight||item.delivery_updated_at||item.greeting_result||item.message_result||item.verification_result||UNCERTAIN.has(item.last_error)))return '本次投递已开始发送或有待核实结果，不能作废。';
    if(batch.jobs.some(item=>['queued','running'].includes(item.review?.pending?.status))
      ||tasks.some(t=>['queued','running'].includes(t.status)&&(t.input?.batch_id===batch.id||t.result?.batch?.id===batch.id||t.input?.replaces_batch_id===batch.id)))return '本次投递安排正在处理，请结束后再作废。';
    if(tasks.some(t=>t.kind==='profile'&&['queued','running'].includes(t.status)
      &&(t.result?.impact?.batch_ids?.includes(batch.id)||t.result?.impact?.job_ids?.some(id=>ids.has(id))
        ||t.input?.mode==='introduction'&&!t.result?.impact&&batch.status==='reviewing')))return '个人介绍更新涉及本次投递安排，请处理结束后再作废。';
    const weekly=store.getSetting('weekCleanup',{});
    if(weekly.due||['running','waiting','failed'].includes(weekly.status))return '请先完成本周清理，再作废投递安排。';
    return '';
  }
  function voidBatch(batchId,{confirmed,expectation_id}={}) {
    if(confirmed!==true)throw new Error('请先确认作废本次投递安排及重新准备投递的费用。');
    return store.transaction(()=>{
      const batch=get(batchId,expectation_id),reason=voidReason(batch);
      if(reason)throw new Error(reason);
      const voided_at=now(),job_count=batch.jobs.length;
      for(const task of store.listTasks()){
        if(task.kind==='jobs'&&(task.id===batch.task_id||task.result?.batch?.id===batch.id)){
          task.result={...task.result,stage:'批次已作废',batch:{status:'voided',id:batch.id,count:job_count,voided_at}};
          store.saveTask({...task,updated_at:voided_at});
        }else if(task.input?.batch_id===batch.id){
          store.saveTask({...task,status:'abandoned',input:{batch_id:batch.id},result:{},error:'本次投递安排已作废，旧请求无法恢复。',updated_at:voided_at});
        }
      }
      save({id:batch.id,expectation_id:batch.expectation_id,created_at:batch.created_at,status:'voided',job_count,voided_at,jobs:[]});
      return view(batch.id);
    });
  }
  function view(batchId, expectationId) {
    const batch = get(batchId, expectationId);
    const jobs = batch.jobs.map(item => ({ ...item,choice:item.choice??'deliver', ...copy(current(item)) }));
    const counts = { total: jobs.length, ready: jobs.filter(j => j.choice === 'deliver').length,
      no: jobs.filter(j => j.choice === 'skip').length,
      modifying: jobs.filter(j => j.review?.pending?.status === 'running').length,
      failed: jobs.filter(j => j.review?.pending?.status === 'failed').length };
    const void_reason=voidReason(batch);
    return { ...batch, jobs, counts, can_void:!void_reason,void_reason, can_submit: batch.status === 'reviewing'
      && jobs.length > 0 && jobs.every(j => ['deliver', 'skip'].includes(j.choice) && !j.review?.pending)
      && jobs.every(j => j.choice !== 'deliver' || j.message.trim()) };
  }
  function choose(batchId, jobId, choice, existingProgress) {
    if (!['deliver', 'skip', 'error'].includes(choice)) throw new Error('请选择可投递、不投递或打招呼消息错误。');
    const batch = editable(batchId);
    const item = record(batch, jobId);
    const nextChoice=item.choice===choice && !(choice==='skip' && existingProgress!==undefined) ? 'deliver' : choice;
    if (nextChoice === 'deliver' && !current(item).message.trim()) throw new Error('空消息不能选择为可投递。');
    item.choice = nextChoice;
    item.existing_progress = nextChoice === 'skip' ? (existingProgress ?? item.existing_progress ?? null) : null;
    save(batch);
    return view(batchId);
  }
  function beginEdit(batchId,jobId){
    const batch=editable(batchId),item=record(batch,jobId);
    if(item.review.pending)throw new Error('请先处理原未完成修改。');
    if(!item.review.original){const profile=store.getProfile(),value=current(item);item.review.original={original_message:value.message,original_mappings:copy(value.mappings??null),full_jd:value.jd_basis??item.job?.jd??null,introduction:profile.introduction,facts:copy(profile.facts),sources:copy(value.sources||[])};save(batch);}
    return view(batchId);
  }
  function removeJob(batchId, jobId, { confirmed } = {}) {
    if (confirmed !== true) throw new Error('请先确认移除该岗位。');
    return store.transaction(() => {
      const batch = get(batchId);
      if (!['reviewing', 'submitted', 'completed'].includes(batch.status)) throw new Error('当前投递安排不能移除岗位。');
      const item = record(batch, jobId);
      if (!['prepared', 'not_delivering'].includes(item.delivery_status) || item.delivery_inflight
        || item.delivery_updated_at || item.greeting_result || item.message_result || item.verification_result
        || UNCERTAIN.has(item.last_error)) throw new Error('岗位已开始发送或有待核实结果，不能移除。');
      if (item.review.pending || store.listTasks().some(t => ['queued', 'running',...(['delivery','verification'].includes(t.kind)?['paused']:[])].includes(t.status)
        && (t.kind === 'profile' || ['delivery', 'verification'].includes(t.kind)
          && (t.input?.scope ? t.input.scope.some(r => r.batch_id === batchId && r.job_id === jobId)
            : t.input?.batch_id === batchId && (!t.input.job_id || t.input.job_id === jobId))))) {
        throw new Error('岗位正在处理，请结束后再移除。');
      }
      const weekly = store.getSetting('weekCleanup', {});
      if (['running', 'waiting', 'failed'].includes(weekly.status)) throw new Error('请先完成本周清理。');
      const latest = store.getJob(jobId);
      if (!latest) throw new Error('岗位记录不存在。');
      // Keep the approved material and existing learning snapshots for history.
      batch.removed_jobs = [...(batch.removed_jobs || []), { ...item, removed_at: now(), removal_reason: '用户手动淘汰' }];
      batch.jobs = batch.jobs.filter(j => j.job_id !== jobId);
      if (!batch.jobs.length) batch.status = 'completed';
      store.saveJob({ ...latest, verdict: 'eliminated', reason: '用户手动淘汰' });
      save(batch);
      return view(batchId);
    });
  }
  function saveMessage(batchId,jobId,message){
    if(typeof message!=='string'||!message.trim())throw new Error('消息不能为空。');
    beginEdit(batchId,jobId);
    const batch=editable(batchId),item=record(batch,jobId),original=item.review.original;
    item.review.draft={message,mappings:message===original.original_message?copy(original.original_mappings||[]):[],sources:message===original.original_message?copy(original.sources||[]):[],jd_basis:original.full_jd};
    if(!item.choice||item.choice==='error')item.choice='deliver';save(batch);return view(batchId);
  }
  function discardLegacyReview(id,{confirmed}={}) {
    if(confirmed!==true)throw new Error('请先确认结束旧版未完成修改。');
    const task=store.getTask(id);
    if(task&&task.kind!=='review')throw new Error('该任务不是旧版消息修改。');
    const batch=store.listBatches().find(b=>b.jobs.some(item=>item.review?.pending?.id===id));
    if(!task&&!batch)throw new Error('没有该旧版未完成修改。');
    if(batch)editable(batch.id);
    if(task&&['completed','abandoned','cancelled'].includes(task.status)&&!batch)throw new Error('旧版修改已结束。');
    return store.transaction(()=>{
      if(batch){const item=batch.jobs.find(item=>item.review?.pending?.id===id);item.review.pending=null;if(item.choice==='error')item.choice=null;save(batch);}
      if(task&&!['completed','abandoned','cancelled'].includes(task.status))store.saveTask({...task,status:'abandoned',updated_at:now()});
      return {task:store.getTask(id),...(batch?{batch:view(batch.id)}:{})};
    });
  }
  function submit(batchId, { confirmed } = {}) {
    if (confirmed !== true) throw new Error('请先确认本次投递的审阅结果。');
    if(get(batchId).reviewed_at)return view(batchId);
    let learningId;
    const result=store.transaction(() => {
      const batch = editable(batchId);
      if (!view(batchId).can_submit) throw new Error('请先完成全部岗位选择及未完成的消息修改。');
      for (const item of batch.jobs) {
        Object.assign(item, copy(current(item)));
        item.delivery_status = item.choice === 'skip' ? 'not_delivering' : 'prepared';
        for (const feedback of Object.values(item.review.feedback || {})) store.saveCase(feedback);
        item.review = { original:item.review.original,pending: null, draft: null, feedback: {} };
      }
      batch.status = batch.jobs.every(j => j.choice === 'skip') ? 'completed' : 'submitted';
      batch.reviewed_at = now();
      learningId=learning.create(batch);
      save(batch);
      return view(batchId);
    });
    if(learningId)learning.schedule(learningId);
    return result;
  }
  function assertExecutionFree(except) {
    if (store.listTasks().some(t => t.id !== except && t.kind !== 'review_learning' && ['queued', 'running',...(['expectations','delivery','verification'].includes(t.kind)?['paused']:[])].includes(t.status))) throw new Error('已有岗位或资料任务正在处理。');
    const weekly = store.getSetting('weekCleanup', {});
    if (['running', 'waiting', 'failed'].includes(weekly.status)) throw new Error('请先完成本周清理。');
  }
  function assertDeliveryCurrent(items) {
    // The old delivery flow validates the whole requested set before opening the browser.
    // This project keeps the approved job snapshot rather than a separate version table.
    const fields = ['id', 'boss_id', 'job_id', 'expectation_id', 'current_version_id', 'job_version_id',
      'title', 'company', 'salary', 'experience', 'education', 'tags', 'list_location',
      'city', 'district', 'business_district', 'address', 'jd', 'detail_tags',
      'recruiter', 'recruiter_name', 'recruiter_title', 'industry', 'company_size', 'detail_url', 'url'];
    for (const item of items) {
      const approved = item.job, latest = store.getJob(item.job_id);
      if (!approved || !latest || fields.some(field => !isDeepStrictEqual(approved[field], latest[field]))) {
        throw new Error(`岗位 ${item.job_id} 的当前内容与已确认的投递安排不一致，已停止投递。`);
      }
      detailUrl(approved);
    }
  }
  const pendingDelivery = batch => batch.jobs.filter(j => j.choice === 'deliver'
    && ['prepared','greeting_sent','chat_located'].includes(j.delivery_status) && !j.delivery_inflight && !UNCERTAIN.has(j.last_error));
  const deliveryItems = task => (task.input.scope || get(task.input.batch_id).jobs.map(j=>({batch_id:task.input.batch_id,job_id:j.job_id})))
    .filter(ref=>!get(ref.batch_id).removed_jobs?.some(j=>j.job_id===ref.job_id))
    .map(ref=>({...record(get(ref.batch_id),ref.job_id),batch_id:ref.batch_id}));
  function deliver(batchId, { confirmed, expectation_id, scope } = {}) {
    if (confirmed !== true) throw new Error('请先人工确认实际投递。');
    assertExecutionFree();
    const batch = batchId ? get(batchId,expectation_id) : null;
    if(!batch && !scope)throw new Error('请先确认当前列表的投递范围。');
    expectation_id ||= batch?.expectation_id;
    if(!expectation_id || !store.getExpectation(expectation_id))throw new Error('请先选择当前求职期望。');
    if(scope!==undefined && (!Array.isArray(scope)||!scope.length))throw new Error('请先确认当前列表的投递范围。');
    const refs=scope || pendingDelivery(batch).map(j=>({batch_id:batch.id,job_id:j.job_id}));
    const seen=new Set();
    const unfinished=store.listTasks().filter(t=>t.kind==='delivery'&&['failed','paused'].includes(t.status));
    const pending=refs.map(ref=>{
      const owner=get(ref.batch_id,expectation_id);
      if(batchId && owner.id!==batchId)throw new Error('投递范围不属于当前投递安排。');
      if(owner.status!=='submitted')throw new Error('仅已完成审阅且处于待投递状态的投递安排可以发送。');
      const item=pendingDelivery(owner).find(j=>j.job_id===ref.job_id);
      if(!item || seen.has(ref.job_id))throw new Error('当前列表已变化或包含不可发送的岗位，请重新确认。');
      if(unfinished.some(t=>t.input.scope?t.input.scope.some(r=>r.batch_id===owner.id&&r.job_id===item.job_id):t.input.batch_id===owner.id))throw new Error('该岗位已有未完成投递任务，请继续原任务。');
      seen.add(ref.job_id);return {...item,batch_id:owner.id};
    });
    if (!pending.length) {
      throw new Error('没有可继续发送的岗位；待核实岗位请先核实结果。');
    }
    assertDeliveryCurrent(pending);
    const task = store.saveTask({ id: randomUUID(), kind: 'delivery', expectation_id,
      status: 'queued', pause_requested:false,input: { ...(batchId?{batch_id:batchId}:{}), confirmed: true,scope:pending.map(j=>({batch_id:j.batch_id,job_id:j.job_id})) }, result: {stage:'发起沟通',progress:{type:'browser',stage:'发起沟通',completed:0,total:pending.length}}, created_at: now() });
    queueMicrotask(() => { void runDelivery(task.id, 'first'); });
    return task;
  }
  function retryDelivery(taskId, { confirmed } = {}, resume=false) {
    if (confirmed !== true) throw new Error('请先人工确认继续投递。');
    const task = store.getTask(taskId);
    if (task?.kind !== 'delivery' || task.status !== (resume?'paused':'failed')) throw new Error('当前投递任务不能继续。');
    assertExecutionFree(taskId);
    if(!task.input.scope)task.input.scope=pendingDelivery(get(task.input.batch_id)).map(j=>({batch_id:task.input.batch_id,job_id:j.job_id}));
    assertDeliveryCurrent(deliveryItems(task).filter(j=>pendingDelivery({jobs:[j]}).length));
    task.status = 'queued';
    task.error = null;
    if(!resume){delete task.result.prepared_chat;delete task.result.failure_progress;}
    task.pause_requested=false;
    task.stop_requested = false;
    store.saveTask(task);
    queueMicrotask(() => { void runDelivery(taskId, 'resume'); });
    return task;
  }
  function pauseTask(id,kind,name) {
    const task=store.getTask(id);
    if(task?.kind!==kind||!['queued','running'].includes(task.status))throw new Error('当前任务不能暂停。');
    store.saveTask({...task,pause_requested:true,updated_at:now()});
    progress?.update?.({taskId:id,name,...task.result.progress,status:'pausing'});return store.getTask(id);
  }
  const pauseDelivery=id=>pauseTask(id,'delivery','实际投递');
  const pauseVerification=id=>pauseTask(id,'verification','核实投递结果');
  const resumeDelivery=(id,input)=>retryDelivery(id,input,true);
  function abandonTask(id,kind,{confirmed}={}) {
    if(confirmed!==true)throw new Error('请先确认放弃本次任务。');
    const task=store.getTask(id);
    if(task?.kind!==kind||!['paused','failed'].includes(task.status))throw new Error('请先暂停任务，再放弃本次任务。');
    store.saveTask({...task,status:'abandoned',pause_requested:false,error:null,updated_at:now()});
    progress?.finish?.({taskId:id,status:'abandoned'});return store.getTask(id);
  }
  const abandonDelivery=(id,input)=>abandonTask(id,'delivery',input);
  const abandonVerification=(id,input)=>abandonTask(id,'verification',input);
  function showDelivery(taskId,stage) {
    const task=store.getTask(taskId),items=deliveryItems(task);
    const located=new Set((task.result.prepared_chat?.value.items||[]).map(plan=>task.result.prepared_chat.refs[Number(plan.item_no)-1]));
    const completed=items.filter(j=>stage==='发起沟通'?j.delivery_status!=='prepared'&&!j.delivery_inflight&&!UNCERTAIN.has(j.last_error):stage==='聊天批次定位'?FINAL_DELIVERY.has(j.delivery_status)||located.has(`${j.batch_id}/${j.job_id}`):FINAL_DELIVERY.has(j.delivery_status)).length;
    const value={type:'browser',stage,completed,total:items.length};
    store.saveTask({...task,result:{...task.result,stage,progress:value},updated_at:now()});
    progress?.update?.({taskId,name:'实际投递',...value,status:task.pause_requested?'pausing':task.status});
  }
  function stopDelivery(taskId) {
    const task = store.getTask(taskId);
    if (task?.kind !== 'delivery' || !['queued', 'running'].includes(task.status)) throw new Error('当前投递任务没有正在运行。');
    task.stop_requested = true;
    store.saveTask({ ...task, updated_at: now() });
    deliverySignals.get(taskId)?.abort();
    progress?.update?.({ taskId, name: '实际投递', type: 'browser', status: task.status, stage: '正在停止' });
    return store.getTask(taskId);
  }
  function runDelivery(taskId, deliveryEntry = 'direct') {
    if (runners.has(taskId)) return runners.get(taskId);
    const work = executeDelivery(taskId, deliveryEntry).finally(() => { runners.delete(taskId); deliverySignals.delete(taskId); });
    runners.set(taskId, work);
    return work;
  }
  const persistDelivery = (batchId, jobId, changes) => {
    const batch = get(batchId);
    const item = record(batch, jobId);
    Object.assign(item, changes, { delivery_updated_at: now() });
    if (batch.jobs.every(j => FINAL_DELIVERY.has(j.delivery_status))) batch.status = 'completed';
    save(batch);
    return item;
  };
  const applyOutcome = outcome => {
    if (outcome.already_contacted || outcome.status === 'already_contacted') return 'already_contacted';
    if (outcome.job_closed || outcome.status === 'job_closed' || outcome.error === 'job_closed') return 'job_closed';
    if (outcome.headhunter_skipped || outcome.status === 'headhunter_skipped') return 'headhunter_skipped';
    if (outcome.greeting_sent) return 'greeting_sent';
    return null;
  };
  async function executeDelivery(taskId, deliveryEntry) {
    const task = store.getTask(taskId);
    const originalStages = new Map(deliveryItems(task).map(item=>[`${item.batch_id}/${item.job_id}`,item.delivery_status]));
    const controller = new AbortController();
    deliverySignals.set(taskId, controller);
    const stopping = () => store.getTask(taskId)?.stop_requested || controller.signal.aborted;
    const active = () => { if (stopping()) throw new Error('实际投递已停止，已保留结果，可人工继续。'); };
    const checkpoint=()=>{active();if(store.getTask(taskId)?.pause_requested)throw PAUSE;};
    try {
      assertExecutionFree(taskId);
      checkpoint();
      assertDeliveryCurrent(deliveryItems(task).filter(j=>pendingDelivery({jobs:[j]}).length));
      store.saveTask({ ...task, status: 'running', updated_at: now() });
      // Keep the established two phases: finish eligible fixed greetings before second messages.
      for (const saved of deliveryItems(task)) {
        checkpoint();
        if (saved.choice !== 'deliver' || saved.delivery_status !== 'prepared' || UNCERTAIN.has(saved.last_error)) continue;
        const job = saved.job || store.getJob(saved.job_id);
        let outcome;
        showDelivery(taskId,'发起沟通');
        persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: 'greeting' });
        try { outcome = await external.applyFromDetails({ job, taskId, signal: controller.signal }); }
        catch (error) {
          persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, last_error: 'greeting_outcome_unknown' });
          throw new Error('发起沟通结果未确认，请先核实后继续。');
        }
        if (stopping()) {
          persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, last_error: 'greeting_outcome_unknown' });
          throw new Error('投递已停止，在途发起沟通结果需先核实后继续。');
        }
        const status = applyOutcome(outcome);
        const confirmed = outcome.confirmation_visible || outcome.confirmed;
        if (status) persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, delivery_status: status, last_error: outcome.greeting_sent && !confirmed ? 'greeting_outcome_unknown' : null, greeting_result: outcome });
        else persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, last_error: outcome.error || outcome.reason || 'greeting_not_sent', greeting_result: outcome });
        if (!status || outcome.greeting_sent && !confirmed) throw new Error('详情沟通未确认完成，请按原流程核实或继续。');
      }
      checkpoint();
      const cached=store.getTask(taskId).result.prepared_chat;
      const eligible = deliveryItems(task).filter(saved => saved.choice === 'deliver'
        && ['greeting_sent', 'chat_located'].includes(saved.delivery_status) && !UNCERTAIN.has(saved.last_error));
      assertDeliveryCurrent(eligible);
      if (eligible.length) {
        showDelivery(taskId,'聊天批次定位');
      }
      const prepared = cached?.value || (eligible.length ? await external.prepareChatBatch({
        jobs: eligible.map(saved => saved.job || store.getJob(saved.job_id)), taskId, signal: controller.signal, chatContext: {delivery_entry:deliveryEntry, job_stages:eligible.map(saved=>({job_id:saved.job_id,original_stage:originalStages.get(`${saved.batch_id}/${saved.job_id}`)}))},
      }) : null);
      active();
      if (prepared && prepared.status !== 'ok') {
        if (prepared.login_required || prepared.security_required || ['login_required', 'verification_required'].includes(prepared.login_state)) throw Object.assign(new Error('本次投递的聊天会话定位未完成，请处理登录或验证后继续。'), prepared.contact_diagnostic?{contact_diagnostic:prepared.contact_diagnostic}:{});
        throw Object.assign(new Error(`本次投递的聊天会话定位未完成（${prepared.error || prepared.stop_reason || prepared.reason || prepared.status}），尚未尝试发送定制消息，请检查聊天页面后继续。`), prepared.contact_diagnostic?{contact_diagnostic:prepared.contact_diagnostic}:{});
      }
      if(prepared&&!cached)store.saveTask({...store.getTask(taskId),result:{...store.getTask(taskId).result,prepared_chat:{value:prepared,refs:eligible.map(j=>`${j.batch_id}/${j.job_id}`)}}});
      checkpoint();
      const planRefs=cached?.refs||eligible.map(j=>`${j.batch_id}/${j.job_id}`);
      const plans = new Map((prepared?.items || []).map(plan => [planRefs[Number(plan.item_no)-1], plan]));
      for (const [index, saved] of eligible.entries()) {
        checkpoint();
        const job = saved.job || store.getJob(saved.job_id);
        const plan = plans.get(`${saved.batch_id}/${saved.job_id}`);
        if (!plan) {
          store.saveTask({ ...store.getTask(taskId), result: { ...store.getTask(taskId).result, stage: '聊天批次定位' }, updated_at: now() });
          showDelivery(taskId,'聊天批次定位');
          throw new Error('本次投递缺少当前岗位的聊天会话定位计划，请在原页面继续。');
        }
        let outcome;
        if (plan.status === 'failed') {
          persistDelivery(saved.batch_id, saved.job_id, { last_error: plan.error || 'chat_contact_not_found',
            message_result: { status: 'failed', send_result: { status: 'not_attempted' }, plan } });
          store.saveTask({ ...store.getTask(taskId), result: { ...store.getTask(taskId).result, failure_progress: { stage: '聊天批次定位' } }, updated_at: now() });
          continue;
        }
        showDelivery(taskId,'发送已确认消息');
        persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: 'message' });
        try { outcome = await external.sendFromChat({ job, message: saved.message, plan, snapshot: prepared.snapshot, taskId, signal: controller.signal, chatContext: {delivery_entry:deliveryEntry, original_stage:originalStages.get(`${saved.batch_id}/${saved.job_id}`), prepare_action_id:prepared.contact_diagnostic?.action_id, prepared_window:prepared.contact_diagnostic?.events?.find(e=>e.stage==='prepare.after')?.target_window, prepared_document:prepared.contact_diagnostic?.events?.find(e=>e.stage==='prepare.document')?.document_runtime_id} }); }
        catch (error) {
          persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, last_error: 'chat_send_outcome_unknown', ...(error.contact_diagnostic?{contact_diagnostic:error.contact_diagnostic}:{}) });
          throw new Error('消息发送结果不确定，请先人工核实；不会自动重发。');
        }
        if (stopping()) {
          persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, last_error: 'chat_send_outcome_unknown' });
          throw new Error('投递已停止，在途消息发送结果需先核实；不会自动重发。');
        }
        if (outcome.message_sent || outcome.already_sent || outcome.status === 'message_sent') {
          persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, delivery_status: 'message_sent', last_error: null, message_result: outcome, sent_at: now() });
        } else {
          const error = outcome.error || outcome.send_result?.error || outcome.reason || 'chat_send_outcome_unknown';
          persistDelivery(saved.batch_id, saved.job_id, { delivery_inflight: null, last_error: error, message_result: outcome });
          store.saveTask({ ...store.getTask(taskId), result: { ...store.getTask(taskId).result, failure_progress: { stage: '发送已确认消息' } }, updated_at: now() });
          // Structured single-job uncertainty is isolated. An unstructured exception stops the batch.
          if (outcome.login_required || outcome.security_required || ['login_required', 'verification_required'].includes(outcome.login_state)) throw new Error('投递需要用户处理登录或验证后继续。');
          if (outcome.stop_reason) {
            const reasons = { chat_input_not_found: '未找到当前聊天的消息输入框', chat_input_verification_failed: '聊天输入内容校验失败', send_button_not_found: '未找到当前聊天的发送按钮', unexpected_chat_message_error: '聊天消息处理异常' };
            const notAttempted = outcome.send_result?.status === 'not_attempted' || ['chat_input_not_found', 'chat_input_verification_failed', 'send_button_not_found'].includes(outcome.stop_reason);
            throw new Error(`${reasons[outcome.stop_reason] || `消息发送已停止（${outcome.stop_reason}）`}，${notAttempted ? '尚未尝试发送定制消息，' : '请先核实当前消息状态，'}请检查聊天页面后继续。`);
          }
        }
      }
      showDelivery(taskId,eligible.length?'发送已确认消息':'');checkpoint();
      const pending = deliveryItems(task).filter(j => j.choice === 'deliver' && !FINAL_DELIVERY.has(j.delivery_status));
      const result = store.getTask(taskId).result;
      const headerMismatch = pending.some(item => item.last_error === 'matching_chat_header_mismatch'
        && item.message_result?.send_result?.status === 'not_attempted');
      const failureMessage = !pending.length ? null : headerMismatch
        ? '有岗位尚未确认进入目标聊天，会话头部未通过已确认岗位核对；该岗位尚未尝试发送定制消息，请检查聊天页面后继续。'
        : '本次投递仍有未完成或待核实岗位。';
      store.saveTask({ ...store.getTask(taskId), status: pending.length ? 'failed' : 'completed',
        error: failureMessage,
        result: pending.length ? { ...result, stage: result.failure_progress?.stage || result.stage,progress:{...result.progress,stage:result.failure_progress?.stage||result.stage} } : { ...result, stage: 'completed',progress:{type:'browser',stage:'completed',completed:deliveryItems(task).length,total:deliveryItems(task).length} }, updated_at: now() });
      progress?.finish?.({ taskId, status: pending.length ? 'failed' : 'completed', ...(headerMismatch ? { error: failureMessage } : {}) });
    } catch (error) {
      const current = store.getTask(taskId);
      if(error===PAUSE){showDelivery(taskId,current.result?.stage||'实际投递');const saved=store.getTask(taskId);store.saveTask({...saved,status:'paused',pause_requested:false,error:null,updated_at:now()});progress?.update?.({taskId,name:'实际投递',...saved.result.progress,status:'paused'});return store.getTask(taskId);}
      store.saveTask({ ...current, status: 'failed', pause_requested:false,error: error.message,
        result: { ...(current.result?.stage?{...current.result,failure_progress:{stage:current.result.stage}}:{}), ...(error.contact_diagnostic?{contact_diagnostic:error.contact_diagnostic}:{}) }, updated_at: now() });
      progress?.finish?.({ taskId, status: 'failed', error: error.message });
    }
    return store.getTask(taskId);
  }
  function stopVerification(id) {
    const task=store.getTask(id);
    if(task?.kind!=='verification' || !['queued','running'].includes(task.status))throw new Error('当前投递核实没有正在运行。');
    store.saveTask({...task,stop_requested:true,updated_at:now()});verificationSignals.get(id)?.abort();
    progress?.update?.({taskId:id,name:'核实投递结果',type:'browser',stage:'正在停止',status:task.status});
    return store.getTask(id);
  }
  function verificationProgress(taskId,stage,completed) {
    const task=store.getTask(taskId),value={type:'browser',stage,completed,total:1};
    store.saveTask({...task,result:{...task.result,stage,progress:value},updated_at:now()});
    progress?.update?.({taskId,name:'核实投递结果',...value,status:task.pause_requested?'pausing':task.status});
  }
  function runVerification(id,confirmed_sent=false) {
    if(runners.has(id))return runners.get(id);
    const controller=new AbortController();verificationSignals.set(id,controller);
    const work=Promise.resolve().then(async()=>{
      const active=()=>{if(controller.signal.aborted||store.getTask(id)?.stop_requested)throw new Error('本次投递核实已停止，请在原页面手动核实。');};
      const checkpoint=()=>{active();if(store.getTask(id)?.pause_requested)throw PAUSE;};
      try {
        assertExecutionFree(id);checkpoint();
        let task=store.getTask(id);store.saveTask({...task,status:'running',updated_at:now()});
        const {batch_id:batchId,job_id:jobId}=task.input;
        if(!task.result.verification){
          verificationProgress(id,'核实当前聊天记录',0);
          const outcome=await external.verifyDelivery({job:task.input.job,message:task.input.message,phase:task.input.phase,fixed_greeting:task.input.fixed_greeting,taskId:id,signal:controller.signal});active();
          const greeting=task.input.phase==='greeting';
          if(greeting&&(outcome.greeting_sent&&(outcome.confirmation_visible||outcome.confirmed)||confirmed_sent===true))persistDelivery(batchId,jobId,{delivery_status:'greeting_sent',last_error:null,verified_at:now(),verification_result:outcome});
          else if(!greeting&&(outcome.message_sent||outcome.already_sent||confirmed_sent===true))persistDelivery(batchId,jobId,{delivery_status:'message_sent',last_error:null,verified_at:now(),verification_result:outcome});
          task=store.getTask(id);store.saveTask({...task,result:{...task.result,verification:outcome}});
        }
        verificationProgress(id,'核实当前聊天记录',1);checkpoint();
        store.saveTask({...store.getTask(id),status:'completed',pause_requested:false,error:null,updated_at:now()});progress?.finish?.({taskId:id,status:'completed'});return view(batchId);
      } catch(error) {
        const task=store.getTask(id);
        if(error===PAUSE){store.saveTask({...task,status:'paused',pause_requested:false,error:null,updated_at:now()});progress?.update?.({taskId:id,name:'核实投递结果',...task.result.progress,status:'paused'});return view(task.input.batch_id);}
        store.saveTask({...task,status:'failed',pause_requested:false,error:error.message,updated_at:now()});progress?.finish?.({taskId:id,status:'failed',error:error.message});throw error;
      }
    }).finally(()=>{runners.delete(id);verificationSignals.delete(id);});runners.set(id,work);return work;
  }
  function retryVerification(id,input={},resume=false) {
    const task=store.getTask(id);
    if(task?.kind!=='verification'||task.status!==(resume?'paused':'failed'))throw new Error('当前核实任务不能继续。');
    assertExecutionFree(id);
    store.saveTask({...task,status:'queued',pause_requested:false,stop_requested:false,error:null,updated_at:now()});
    queueMicrotask(()=>{void runVerification(id).catch(()=>{});});return store.getTask(id);
  }
  const resumeVerification=(id,input={})=>retryVerification(id,input,true);
  async function verifyDelivery(batchId, jobId, { confirmed_sent } = {}) {
    assertExecutionFree();
    const batch=get(batchId),item=record(batch,jobId);
    if(!UNCERTAIN.has(item.last_error))throw new Error('本岗位没有待核实发送结果。');
    const task=store.saveTask({id:randomUUID(),kind:'verification',expectation_id:batch.expectation_id,status:'queued',stop_requested:false,pause_requested:false,input:{batch_id:batchId,job_id:jobId,job:copy(item.job||store.getJob(jobId)),message:item.message,phase:item.last_error==='greeting_outcome_unknown'?'greeting':'message',fixed_greeting:item.greeting_result?.fixed_greeting},result:{progress:{type:'browser',stage:'核实当前聊天记录',completed:0,total:1}}});
    return await runVerification(task.id,confirmed_sent);
  }
  return { view, voidBatch, choose, beginEdit, removeJob, saveMessage, learning, discardLegacyReview, submit,
    deliver, retryDelivery, resumeDelivery, pauseDelivery, abandonDelivery, stopDelivery, runDelivery, verifyDelivery, retryVerification, resumeVerification, pauseVerification, abandonVerification, stopVerification, runners };
}
