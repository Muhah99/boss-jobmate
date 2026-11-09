import { randomUUID } from 'node:crypto';
import { jobTags, buildPrompt, OUTPUT_SCHEMAS } from './agent-prompts.mjs';
import { isDeepStrictEqual } from 'node:util';
import { CALL_CONFIG, modelConcurrency } from './agent-runtime.mjs';

const TERMINAL = new Set(['completed', 'abandoned', 'cancelled']);
const ORDER = { high: 0, medium: 1, low: 2 };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PAUSE = Symbol('jobs.pause');
const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const role = expectation => ({ title: expectation.title, city: expectation.city });

// All writes below are synchronous short transactions. No database transaction waits for I/O.
export function createJobWorkflows({ store, agent, external, progress, clock = Date.now }) {
  const runners = new Map();
  const signals = new Map();
  const settings = () => ({ message_max_chars:60, ...store.getSetting('settings', {}), map_configured: Boolean(
    store.getSetting('secrets', {}).map_ak && store.getSetting('secrets', {}).map_sk) });
  const save = task => store.saveTask({ ...task, updated_at: now() });
  const alive = id => {
    const task = store.getTask(id);
    if (!task || TERMINAL.has(task.status)) throw new Error('本次任务已经结束。');
    if (task.stop_requested) throw new Error('本次任务已停止，已保留结果，可人工继续。');
    return task;
  };
  const patch = (id, change) => {
    const task = alive(id);
    change(task);
    return save(task);
  };
  const checkpoint = id => { if (alive(id).pause_requested) throw PAUSE; };
  const show = (id, type, stage, completed, total) => {
    const task = patch(id, task => {
      task.result.stage = stage;
      task.result.progress = { type, stage, completed, total };
    });
    progress?.update?.({ taskId: id, name: '岗位任务', status: task.status, ...task.result.progress });
  };
  function assertAvailable(except) {
    const parent=except && store.getTask(except)?.input?.rebuild_parent;
    if (store.listTasks().some(t => t.id !== except && t.kind!=='review_learning' && (['queued', 'running'].includes(t.status)||t.status==='paused'&&['expectations','delivery','verification'].includes(t.kind))
      && !(parent && t.input?.rebuild_parent===parent && t.status==='queued'))) {
      throw new Error('已有任务正在处理，请等待其结束。');
    }
    const weekly = store.getSetting('weekCleanup', {});
    if (['running', 'failed', 'waiting'].includes(weekly.status)) throw new Error('请先完成本周清理。');
  }
  function occupiedJobIds(exceptTaskId) {
    const ids = new Set(store.listBatches().flatMap(b => b.jobs.map(j => j.job_id)));
    for (const task of store.listTasks()) {
      if (task.id !== exceptTaskId && task.kind === 'jobs' && !TERMINAL.has(task.status)) {
        for (const id of task.result?.batch?.job_ids || []) ids.add(id);
      }
    }
    return ids;
  }
  function linkedBossIds(exceptTaskId) {
    return new Set([...occupiedJobIds(exceptTaskId)].map(id => store.getJob(id)?.boss_id).filter(Boolean).concat([...contactedBossIds()]));
  }
  function contactedBossIds() {
    return new Set(store.listJobs().filter(job => job.contacted || job.already_contacted || job.applied).map(job => job.boss_id).filter(Boolean));
  }
  function taskParams(input, config) {
    const mode = input.mode || 'combined';
    if (!['screening', 'batch', 'combined'].includes(mode)) throw new Error('任务模式不正确。');
    const params = { ...input, mode };
    params.manual_confirm = true;
    for (const key of ['collect_count', 'batch_count']) {
      if (mode === 'screening' && key === 'batch_count' || mode === 'batch' && key === 'collect_count') continue;
      if (!Number.isInteger(Number(params[key])) || Number(params[key]) < 1) throw new Error('岗位数量须为正整数。');
      params[key] = Number(params[key]);
    }
    if ([params.salary_min, params.salary_max].some(value => value == null || String(value).trim() === '')) throw new Error('请填写薪资上下限。');
    const min = Number(params.salary_min);
    const max = Number(params.salary_max);
    if (!Number.isFinite(min) || min < 0 || !Number.isFinite(max) || max < 0 || min > max) throw new Error('薪资范围不正确。');
    params.salary_min = min;
    params.salary_max = max;
    params.commute_mode = config.commute_mode || 'off';
    params.commute_filter = params.commute_mode !== 'off' && Boolean(input.commute_filter ?? params.commute_mode === 'filter');
    if (input.commute_filter && params.commute_mode === 'off') throw new Error('请先在系统配置中开启通勤计算。');
    if (params.commute_filter && (!Number.isFinite(Number(params.commute_max_minutes)) || Number(params.commute_max_minutes) <= 0)) {
      throw new Error('请填写有效的公共交通通勤时间阈值。');
    }
    if (params.commute_tiers !== undefined) {
      if (!Array.isArray(params.commute_tiers) || !params.commute_tiers.length) throw new Error('请填写有效的通勤分档。');
      params.commute_tiers = params.commute_tiers.map((row, index, rows) => {
        const min = Number(row.min), max = Number(row.max);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min
          || index === 0 && min !== 0 || index > 0 && min !== Number(rows[index - 1].max)) {
          throw new Error('通勤分档须为从零开始、连续递增的有效时间范围。');
        }
        return { grade: row.grade, min, max };
      });
    }
    return params;
  }
  function start(input) {
    assertAvailable();
    if (!store.getSetting('onboarding', {}).complete) throw new Error('请先完成初始化。');
    const expectation = store.getExpectation(input.expectation_id);
    if (!expectation) throw new Error('请选择有效的求职期望。');
    const profile = store.getProfile();
    if (!profile?.introduction || !Array.isArray(profile.facts)) throw new Error('请先完成个人资料初始化。');
    const config = settings();
    const params = taskParams(input, config);
    if (params.allow_weekend === false && [0, 6].includes(new Date(clock()).getDay())) throw new Error('本次设置不在周末运行。');
    if (params.commute_filter && (!config.map_configured || !expectation.origins?.length)) {
      throw new Error('通勤过滤需要已保存的地图配置及当前求职期望起点。');
    }
    const task = save({
      id: randomUUID(), kind: 'jobs', expectation_id: expectation.id, status: 'queued', created_at: now(),
      input: { params, expectation: copy(expectation), profile: copy(profile), config: copy(config), cases:copy(store.listCases()) },
      result: {
        stage: 'queued',
        screening: { status: params.mode === 'batch' ? 'not_required' : 'pending', job_ids: null, cache: {} },
        batch: { status: params.mode === 'screening' ? 'not_required' : 'pending', id: null, job_ids: [], updates: {}, messages: {}, refreshes: {}, commute_done: {} },
      },
    });
    const drafts = store.getSetting('taskDrafts', {});
    drafts[expectation.id] = { salary_min: params.salary_min, salary_max: params.salary_max };
    store.setSetting('taskDrafts', drafts);
    schedule(task.id);
    return task;
  }
  function retry(id) {
    const task = store.getTask(id);
    if (task?.kind !== 'jobs' || task.status !== 'failed') throw new Error('当前任务不能重试。');
    assertAvailable(id);
    task.status = 'queued';
    task.error = null;
    task.stop_requested = false;
    task.pause_requested = false;
    for (const attempt of [...Object.values(task.result.evaluation_attempts || {}), ...Object.values(task.result.message_attempts || {})]) {
      attempt.attempts = 0;
      attempt.feedback = null;
    }
    save(task);
    schedule(id);
    return store.getTask(id);
  }
  function pause(id) {
    const task = store.getTask(id);
    if (task?.kind !== 'jobs' || !['queued','running'].includes(task.status)) throw new Error('当前任务不能暂停。');
    task.pause_requested = true;
    save(task);
    // In-flight operations finish and save their results before the next safe boundary.
    progress?.update?.({taskId:id,name:'岗位任务',status:'pausing',...task.result.progress});
    return store.getTask(id);
  }
  function resume(id) {
    const task = store.getTask(id);
    if (task?.kind !== 'jobs' || task.status !== 'paused') throw new Error('当前任务不能恢复。');
    assertAvailable(id);
    task.status = 'queued'; task.pause_requested = false; task.stop_requested = false; task.error = null;
    save(task); schedule(id); return store.getTask(id);
  }
  function stop(id) {
    const task = store.getTask(id);
    if (task?.kind !== 'jobs' || !['queued', 'running'].includes(task.status)) throw new Error('当前任务没有正在运行。');
    task.stop_requested = true;
    save(task);
    signals.get(id)?.abort();
    progress?.update?.({ taskId: id, name: '岗位任务', status: task.status, stage: '正在停止', type: task.result.progress?.type || 'background' });
    return store.getTask(id);
  }
  function abandon(id) {
    const task = store.getTask(id);
    if (task?.kind !== 'jobs' || !['paused','failed'].includes(task.status)) throw new Error('请先暂停任务，再放弃未完成环节。');
    signals.get(id)?.abort();
    task.status = 'abandoned';
    if (task.result.screening.status !== 'completed') task.result.screening = { status: 'abandoned', cache: {} };
    if (task.result.batch.status !== 'completed') task.result.batch = { status: 'abandoned', job_ids: [], updates: {}, messages: {} };
    task.result.stage = 'abandoned';
    save(task);
    progress?.finish?.({ taskId: id, status: 'abandoned' });
    return store.getTask(id);
  }
  function schedule(id) {
    queueMicrotask(() => { void run(id); });
  }
  function run(id) {
    if (runners.has(id)) return runners.get(id);
    const work = execute(id).finally(() => { runners.delete(id); signals.delete(id); });
    runners.set(id, work);
    return work;
  }
  async function execute(id) {
    const controller = new AbortController();
    signals.set(id, controller);
    try {
      assertAvailable(id);
      const task = alive(id);
      if (task.kind !== 'jobs') throw new Error('任务类型不正确。');
      checkpoint(id);
      patch(id, t => { t.status = 'running'; t.error = null; });
      if (!['completed', 'not_required'].includes(task.result.screening.status)) await screening(id, controller.signal);
      checkpoint(id);
      if (!['completed', 'not_required'].includes(alive(id).result.batch.status)) await batch(id, controller.signal);
      checkpoint(id);
      // Both business stages are already committed. Closing never reruns their work.
      let browserClose;
      try { browserClose = await external.closeTaskWindows({ taskId: id, signal: controller.signal }); }
      catch (error) { browserClose = { status: 'failed', closed: false, message: error.message || '专用BOSS浏览器未关闭。' }; }
      patch(id, t => { t.result.browser_close = browserClose; t.status = 'completed'; t.result.stage = 'completed'; });
      progress?.finish?.({ taskId: id, status: 'completed' });
    } catch (error) {
      const task = store.getTask(id);
      if (task && !TERMINAL.has(task.status)) {
        if (error === PAUSE) {
          task.status = 'paused'; task.pause_requested = false; task.error = null;
          save(task);
          progress?.update?.({taskId:id,name:'岗位任务',status:'paused',...task.result.progress});
          return task;
        }
        task.status = 'failed';
        task.pause_requested = false;
        task.error = task.stop_requested ? '本次任务已停止，已保留结果，可人工继续。' : error.message || '任务未完成。';
        if (task.result.screening.status === 'running') task.result.screening.status = 'failed';
        if (task.result.batch.status === 'running') task.result.batch.status = 'failed';
        save(task);
        progress?.finish?.({ taskId: id, status: 'failed', error: task.error });
      }
    }
    return store.getTask(id);
  }
  async function call(id, callId, job, input, signal) {
    checkpoint(id);
    const task = alive(id);
    const messageOutput = ['messages.generate', 'messages.review_cases'].includes(callId);
    if (callId === 'jobs.evaluate' || messageOutput) {
      const ledger = messageOutput ? 'message_attempts' : 'evaluation_attempts';
      const key = messageOutput ? `${job.id}/${callId}` : job.id;
      // Keep this unfinished execution's input and budget through pause/restart.
      if (!task.result[ledger]?.[key]) patch(id, task => {
        (task.result[ledger] ||= {})[key] = { input: copy(input), config: copy(task.input.config), attempts: 0, feedback: null, ...(messageOutput ? { prompt: buildPrompt(callId, input) } : {}) };
      });
      while (true) {
        checkpoint(id);
        if (signal?.aborted) throw signal.reason || new Error('本次任务已停止。');
        const attempt = alive(id).result[ledger][key];
        if (attempt.attempts >= 6) throw new Error(attempt.feedback?.reason || (messageOutput ? '本消息阶段已达到本轮6次调用上限，请手动重试。' : '岗位评估已达到本轮6次调用上限，请手动重试。'));
        patch(id, task => { task.result[ledger][key].attempts++; });
        try {
          const response = await agent.call({ taskId: id, callId, jobId: job.id, input: copy(attempt.input), config: copy(attempt.config), signal,
            outputCorrection: attempt.feedback, outputAttempt: attempt.attempts + 1, ...(messageOutput ? { frozenPrompt: attempt.prompt } : {}) });
          patch(id, task => { delete task.result[ledger][key]; });
          return { output: response.output, metadata: response.metadata };
        } catch (error) {
          alive(id);
          if (!error.outputFailure) throw error;
          patch(id, task => { task.result[ledger][key].feedback = copy(error.outputFailure); });
          checkpoint(id);
          if (alive(id).result[ledger][key].attempts >= 6) throw error;
        }
      }
    }
    const response = await agent.call({ taskId: id, callId, jobId: job.id, input, config: task.input.config, signal });
    alive(id);
    return { output: response.output, metadata: response.metadata };
  }
  const evaluationInput = (task, job) => ({ introduction: task.input.profile.introduction,
    expectation: role(task.input.expectation), title: job.title, tags:jobTags(job), jd: job.jd, conditions: task.input.profile.conditions || '' });
  function evaluation(job, output) {
    return { ...job, verdict: output.condition_hits.length || output.direction_hits.length ? 'eliminated' : 'selected',
      match_level: output.match_level, matches: output.matches, condition_hits: output.condition_hits, direction_hits:output.direction_hits, evaluated_at: now() };
  }
  function programDecision(job, task, batchStage = false) {
    if (job.active === false || job.closed || job.is_headhunter || job.contacted || job.already_contacted || job.applied || job.interviewed_company || job.title_filter_excluded) return 'unqualified';
    if (job.city && task.input.expectation.city && job.city !== task.input.expectation.city) return 'unqualified';
    if (job.program_excluded) return 'unqualified';
    const { salary_min: min, salary_max: max } = task.input.params;
    const salary = job.salary || {};
    const parsed = typeof salary === 'string' ? /^(\d+(?:\.\d+)?)\s*[-—–]\s*(\d+(?:\.\d+)?)\s*[kK]/.exec(salary) : null;
    const low = Number(job.salary_min ?? salary.min ?? salary.low ?? parsed?.[1]);
    const high = Number(job.salary_max ?? salary.max ?? salary.high ?? parsed?.[2]);
    const hasLow = job.salary_min != null || salary.min != null || salary.low != null || parsed;
    const hasHigh = job.salary_max != null || salary.max != null || salary.high != null || parsed;
    if (min != null && hasHigh && Number.isFinite(high) && high < min || max != null && hasLow && Number.isFinite(low) && low > max) {
      return batchStage ? 'skip' : 'unqualified';
    }
    return null;
  }
  async function concurrent(items, worker, config, taskId) {
    let index = 0;
    let error;
    await Promise.all(Array.from({ length: Math.min(modelConcurrency(config), items.length) }, async () => {
      while (!error && index < items.length) {
        try {
          if (taskId) checkpoint(taskId);
          const item = items[index++];
          await worker(item);
        } catch (failure) { if (!error || error === PAUSE) error = failure; }
      }
    }));
    if (error) throw error;
  }
  async function screening(id, signal) {
    patch(id, task => { task.result.screening.status = 'running'; });
    let task = alive(id);
    if (task.result.screening.job_ids === null) {
      show(id, 'browser', '采集岗位', 0, task.input.params.collect_count);
      checkpoint(id);
      const excluded = new Set([...store.listJobs(task.expectation_id).map(j => j.boss_id), ...linkedBossIds()]);
      const collected = await external.collect({ expectation: task.input.expectation,
        params: { ...task.input.params, excluded_job_ids: [...excluded].filter(Boolean) }, taskId: id, signal });
      alive(id);
      const occupiedBoss = linkedBossIds();
      const ids = store.transaction(() => {
        const ids = [];
        for (const data of collected) {
          const existing = store.listJobs(task.expectation_id).find(j => j.boss_id && j.boss_id === data.boss_id);
          if (existing) continue; // Net-new collection only; do not mutate prior official records.
          if (data.boss_id && occupiedBoss.has(data.boss_id)) continue;
          const job = store.saveJob({ ...data, id: randomUUID(), expectation_id: task.expectation_id,
            collected_at: data.collected_at || now(), verdict: null, match_level: null, matches: [], condition_hits: [] });
          ids.push(job.id);
        }
        patch(id, t => { t.result.screening.job_ids = ids;
          t.result.screening.detail_job_ids = ids.filter(jobId => !programDecision(store.getJob(jobId), t));
          t.result.screening.count = t.result.screening.detail_job_ids.length;
        });
        return ids;
      });
      task = alive(id);
      if (!ids.length) show(id, 'background', '匹配评估', 0, 0);
    }
    const ids = task.result.screening.job_ids;
    const cachedEvaluation = jobId => {
      const cached = alive(id).result.screening.cache[jobId]?.job;
      return cached && (cached.verdict === 'unqualified' || Array.isArray(cached.direction_hits));
    };
    // Keep the original detail scope across pause/retry, including reads which later found exclusions.
    const detailIds = task.result.screening.detail_job_ids ?? ids.filter(jobId =>
      !programDecision(store.getJob(jobId), task) || store.getJob(jobId).detail_checked_at);
    if (!task.result.screening.detail_job_ids) patch(id, task => {
      task.result.screening.detail_job_ids = detailIds;
      task.result.screening.count = detailIds.length;
    });
    let detailsCompleted = detailIds.filter(jobId => cachedEvaluation(jobId)
      || store.getJob(jobId).jd || store.getJob(jobId).detail_checked_at).length;
    // Interval belongs only to adjacent reads in this screening execution, never saved/resumed.
    let previousDetailInterval = null;
    // UI Automation is serial; independent evaluations begin only after details are ready.
    for (const jobId of detailIds) {
      if (cachedEvaluation(jobId)) { previousDetailInterval = null; continue; }
      let job = store.getJob(jobId);
      if (programDecision(job, alive(id))) { previousDetailInterval = null; continue; }
      if (!job.jd) {
        checkpoint(id);
        show(id, 'browser', '读取岗位详情', detailsCompleted, detailIds.length);
        const { screeningInterval, ...detail } = await external.readDetail({ job, taskId: id, signal,
          screening: true, previousDetailInterval });
        previousDetailInterval = screeningInterval || null;
        alive(id);
        if (!detail.jd?.trim() && !programDecision(detail, alive(id))) throw new Error('岗位详情缺少完整 JD。');
        job = store.saveJob({ ...job, ...detail, id: job.id, expectation_id: job.expectation_id, detail_checked_at: now() });
        detailsCompleted++;
        show(id, 'browser', '读取岗位详情', detailsCompleted, detailIds.length);
      } else previousDetailInterval = null;
    }
    checkpoint(id);
    // Retain every collection exclusion in the audit/result, without counting it as model work.
    patch(id, task => {
      for (const jobId of ids) {
        const job = store.getJob(jobId);
        if (programDecision(job, task) && !task.result.screening.cache[jobId]) {
          task.result.screening.cache[jobId] = { job: { ...job, verdict: 'unqualified', match_level: null, matches: [], condition_hits: [], direction_hits: [] } };
        }
      }
    });
    const evaluationIds = detailIds.filter(jobId => !programDecision(store.getJob(jobId), alive(id)));
    const remaining = evaluationIds.filter(jobId => !cachedEvaluation(jobId));
    show(id, 'background', '匹配评估', evaluationIds.length - remaining.length, evaluationIds.length);
    await concurrent(remaining, async jobId => {
      const task = alive(id);
      const job = store.getJob(jobId);
      const decision = programDecision(job, task);
      let update;
      let metadata;
      if (decision) update = { ...job, verdict: decision, match_level: null, matches: [], condition_hits: [], direction_hits:[] };
      else {
        if (!job.jd?.trim()) throw new Error('岗位详情缺少完整 JD。');
        const response = await call(id, 'jobs.evaluate', job, evaluationInput(task, job), signal);
        update = evaluation(job, response.output);
        metadata = response.metadata;
      }
      patch(id, task => { task.result.screening.cache[jobId] = { job: update, metadata }; });
      show(id, 'background', '匹配评估', evaluationIds.filter(cachedEvaluation).length, evaluationIds.length);
    }, task.input.config, id);
    checkpoint(id);
    store.transaction(() => {
      const task = alive(id);
      for (const jobId of ids) store.saveJob(task.result.screening.cache[jobId].job);
      task.result.screening = { status: 'completed', count: detailIds.length, cache: {}, job_ids: ids, detail_job_ids: detailIds };
      save(task);
    });
  }
  const expired = job => !Number.isFinite(Date.parse(job.detail_checked_at || job.collected_at))
    || clock() - Date.parse(job.detail_checked_at || job.collected_at) > WEEK_MS;
  const overlayJob = (task, job) => task.result.batch.updates[job.id] || job;
  const ranked = jobs => jobs.sort((a, b) => (ORDER[a.match_level] ?? 3) - (ORDER[b.match_level] ?? 3)
    || Number(a.sequence ?? Date.parse(a.collected_at) ?? 0) - Number(b.sequence ?? Date.parse(b.collected_at) ?? 0));
  function messageSources(output, facts) {
    const catalog = new Map(facts.map(f => [f.fact_id, f]));
    return output.mappings.map(mapping => ({ ...mapping, ...copy(catalog.get(mapping.fact_id)) }));
  }
  function relevantCases(job, message, cases) {
    const expressed = new Set(message.mappings.map(m => m.fact_id));
    const jd = job.jd.toLocaleLowerCase();
    return cases.filter(c => c.current_fact_ids?.length && c.active !== false)
      .filter(c => c.type === 'mismatch' ? c.current_fact_ids.some(id => expressed.has(id))
        : !c.current_fact_ids.every(id => expressed.has(id)) && (c.jd_keywords || []).some(word => jd.includes(word.toLocaleLowerCase())))
      .slice(0, 8);
  }
  async function refreshCandidateDetail(id, job, signal) {
    const refresh = alive(id).result.batch.refreshes[job.id];
    const prior = refresh && !refresh.completed ? refresh.previous : copy(job);
    if (expired(job)) {
      checkpoint(id);
      const detail = await external.readDetail({ job, taskId: id, signal });
      alive(id);
      if (!detail.jd?.trim() && !programDecision(detail, alive(id), true)) throw new Error('岗位详情缺少完整 JD。');
      job = { ...job, ...detail, id: prior.id, expectation_id: prior.expectation_id, detail_checked_at: now() };
      // Cache successful detail reads immediately, but never publish them before this stage commits.
      patch(id, task => {
        task.result.batch.updates[job.id] = job;
        task.result.batch.refreshes[job.id] = { previous: copy(prior), completed: false, check: null };
        if (prior.address !== job.address) delete task.result.batch.commute_done[job.id];
      });
    }
  }
  async function prepareCandidate(id, job, signal, onStage) {
    let task = alive(id);
    const cached = task.result.batch.messages[job.id];
    const refresh = task.result.batch.refreshes[job.id];
    const needsCheck = refresh && (!refresh.completed || refresh.check && !Array.isArray(refresh.check.direction_hits));
    const prior = needsCheck ? refresh.previous : job;
    if (needsCheck) {
      task = alive(id);
      const decision = programDecision(job, task, true);
      if (decision) {
        if (decision === 'unqualified') job = { ...job, verdict: decision, match_level: null, matches: [], condition_hits: [], direction_hits:[] };
        patch(id, task => {
          task.result.batch.updates[job.id] = job;
          task.result.batch.refreshes[job.id].completed = true;
          delete task.result.batch.messages[job.id];
        });
        return { job, skip: true };
      }
      const savedCheck = Array.isArray(refresh.check?.direction_hits) ? refresh.check : null;
      if (!savedCheck || (savedCheck.reevaluate && !savedCheck.condition_hits.length && !savedCheck.direction_hits.length)) onStage('检查工作条件与 JD 变化');
      const check = savedCheck || (await call(id, 'jobs.check_jd_change', job, {
        ...evaluationInput(task, job), previous_jd: prior.jd,
        previous_evaluation: { match_level: prior.match_level, matches: prior.matches || [], condition_hits: prior.condition_hits || [], ...(prior.direction_hits?{direction_hits:prior.direction_hits}:{}) },
        cached_message: cached?.final || cached?.first || null,
      }, signal)).output;
      patch(id, task => { task.result.batch.refreshes[job.id].check = check; });
      if (check.condition_hits.length || check.direction_hits.length) job = { ...job, verdict: 'eliminated', match_level: null, matches: [], condition_hits: check.condition_hits, direction_hits:check.direction_hits };
      else if (check.reevaluate) {
        onStage('匹配评估');
        job = evaluation(job, (await call(id, 'jobs.evaluate', job, evaluationInput(task, job), signal)).output);
      }
      else job = { ...job, condition_hits:[], direction_hits:check.direction_hits };
      patch(id, task => {
        task.result.batch.updates[job.id] = job;
        task.result.batch.refreshes[job.id].completed = true;
        if (job.verdict !== 'selected' || check.message_basis_changed) delete task.result.batch.messages[job.id];
      });
    }
    task = alive(id);
    if (job.verdict !== 'selected' || programDecision(job, task, true)) return { job, skip: true };
    if (task.input.params.commute_mode !== 'off' && !task.result.batch.commute_done[job.id]) {
      const origins = task.input.expectation.origins || [];
      let commute;
      if (!task.input.config.map_configured || !origins.length) commute = { status: 'unconfigured', selected: null, origins: [] };
      else {
        onStage('计算通勤');
        checkpoint(id);
        try { commute = await external.commute({ job, origins, taskId: id, signal }); }
        catch { alive(id); commute = { status: 'failed', selected: null, origins: [] }; }
        alive(id);
      }
      job = { ...job, commute };
      if (commute.selected) {
        const minutes = commute.selected.duration_minutes ?? commute.selected.minutes ?? commute.selected.transit_minutes;
        const tier = (task.input.params.commute_tiers || []).find(row => minutes >= row.min && minutes < row.max);
        if (tier) job.commute.selected.grade = tier.grade;
      }
      patch(id, task => { task.result.batch.updates[job.id] = job; task.result.batch.commute_done[job.id] = true; });
    }
    if (task.input.params.commute_filter) {
      const commute = job.commute;
      const minutes = commute?.selected?.duration_minutes ?? commute?.selected?.minutes ?? commute?.selected?.transit_minutes;
      if (commute?.status !== 'ok' || !Number.isFinite(minutes) || minutes <= 0 || minutes >= task.input.params.commute_max_minutes) return { job, skip: true };
    }
    return { job, skip: false };
  }
  async function batch(id, signal) {
    patch(id, task => { task.result.batch.status = 'running'; });
    const prepared = alive(id).result.batch.prepared || {};
    const checked = new Set(Object.keys(prepared));
    const skipped = new Set(Object.keys(prepared).filter(id => prepared[id].skip));
    const accepted = new Map(Object.keys(prepared).filter(id => !prepared[id].skip).map(jobId => [jobId,true]));
    const occupation = occupiedJobIds(id);
    const bosses = linkedBossIds(id);
    const target = alive(id).input.params.batch_count;
    // Read this round serially, then prepare independent jobs before re-ranking.
    while (true) {
      const task = alive(id);
      const candidates = ranked(store.listJobs(task.expectation_id).map(job => overlayJob(task, job))
        .filter(job => job.verdict === 'selected' && !skipped.has(job.id) && !occupation.has(job.id)
          && !(job.boss_id && bosses.has(job.boss_id))));
      const companies = new Set();
      const top = candidates.filter(job => {
        const company = String(job.company || '').normalize('NFKC').trim();
        if (company && companies.has(company)) return false;
        if (company) companies.add(company);
        return true;
      }).slice(0, target);
      const round = top.filter(job => !checked.has(job.id));
      if (!round.length) {
        const selected = top.filter(job => accepted.has(job.id));
        patch(id, task => {
          task.result.batch.job_ids = selected.map(job => job.id);
          if (selected.length && !task.result.batch.id) task.result.batch.id = randomUUID();
        });
        break;
      }
      const total = checked.size + round.length;
      let details = checked.size;
      const needsDetails = round.some(job => expired(overlayJob(task, job)));
      if (needsDetails) show(id, 'browser', '准备本轮岗位详情', details, total);
      for (const job of round) {
        checkpoint(id);
        await refreshCandidateDetail(id, job, signal);
        details++;
        if (needsDetails) show(id, 'browser', '准备本轮岗位详情', details, total);
      }
      checkpoint(id);
      const activeStages = new Map();
      const reportPreparation = () => {
        const stages = ['检查工作条件与 JD 变化', '匹配评估', '计算通勤'].filter(stage => [...activeStages.values()].includes(stage));
        show(id, 'background', stages.join('、') || '准备候选岗位', checked.size, total);
      };
      reportPreparation();
      await concurrent(round, async candidate => {
        const job = overlayJob(alive(id), store.getJob(candidate.id));
        try {
          const result = await prepareCandidate(id, job, signal, stage => {
            activeStages.set(job.id, stage);
            reportPreparation();
          });
          patch(id, task => { (task.result.batch.prepared ||= {})[job.id] = {skip:result.skip}; });
          checked.add(job.id);
          if (result.skip) skipped.add(job.id); else accepted.set(job.id, result.job);
          // Remove released candidates immediately; other saved associations stay occupied.
          if (result.skip) patch(id, task => { task.result.batch.job_ids = task.result.batch.job_ids.filter(jobId => jobId !== job.id); });
          activeStages.delete(job.id);
        } finally {
          if (!signal.aborted) reportPreparation();
        }
      }, task.input.config, id);
    }
    const ids = alive(id).result.batch.job_ids;
    show(id, 'background', '生成消息与案例复核', ids.filter(jobId => alive(id).result.batch.messages[jobId]?.final).length, ids.length);
    await concurrent(ids, async jobId => {
      let task = alive(id);
      const job = overlayJob(task, store.getJob(jobId));
      let cache = task.result.batch.messages[jobId] || {};
      if (!cache.first) {
        const response = await call(id, 'messages.generate', job, { facts: task.input.profile.facts,
          expectation: role(task.input.expectation), title: job.title, tags:jobTags(job), jd: job.jd, reference: task.input.config.reference || '',
          message_max_chars: task.input.config.message_max_chars ?? 60 }, signal);
        const first = { ...response.output, sources: messageSources(response.output, task.input.profile.facts), jd_basis: job.jd, tags_basis: jobTags(job) };
        patch(id, task => { task.result.batch.messages[jobId] = { first, metadata: response.metadata }; });
        cache = alive(id).result.batch.messages[jobId];
      }
      if (!cache.final) {
        const cases = relevantCases(job, cache.first,task.input.cases??store.listCases());
        let final = cache.first;
        if (cases.length) {
          const factIds = new Set([...cache.first.mappings.map(m => m.fact_id), ...cases.flatMap(c => c.current_fact_ids)]);
          const facts = task.input.profile.facts.filter(f => factIds.has(f.fact_id));
          const response = await call(id, 'messages.review_cases', job, { message: cache.first.message, mappings: cache.first.mappings,title:job.title,tags:jobTags(job),
            facts, jd: job.jd, mismatch_cases: cases.filter(c => c.type === 'mismatch'), omission_cases: cases.filter(c => c.type === 'omission'),
            message_max_chars: task.input.config.message_max_chars ?? 60 }, signal);
          final = { ...response.output, sources: messageSources(response.output, task.input.profile.facts), jd_basis: job.jd, tags_basis: jobTags(job) };
        }
        patch(id, task => { task.result.batch.messages[jobId].final = final; });
      }
      show(id, 'background', '生成消息与案例复核', ids.filter(candidateId => alive(id).result.batch.messages[candidateId]?.final).length, ids.length);
    }, alive(id).input.config, id);
    checkpoint(id);
    store.transaction(() => {
      const task = alive(id);
      const cache = task.result.batch;
      // Old preparation entries excluded from this run must not overwrite later jobs.
      for (const job of Object.values(cache.updates)) if (checked.has(job.id) && store.getJob(job.id)) store.saveJob(job);
      if (ids.length) store.saveBatch({ id: cache.id, expectation_id: task.expectation_id, task_id: id, status: 'reviewing', created_at: now(),
        params: task.input.params, jobs: ids.map(jobId => ({ job_id: jobId, job: copy(overlayJob(task, store.getJob(jobId))),
          ...copy(cache.messages[jobId].final), choice: 'deliver', delivery_status: 'prepared',
          review: { feedback: {}, pending: null, draft: null } })) });
      task.result.batch = { status: 'completed', id: cache.id, count: ids.length, job_ids: ids, updates: {}, messages: {} };
      save(task);
    });
  }
  function introductionScope() {
    const batches=store.listBatches().filter(b=>b.status==='reviewing');
    const protectedIds=new Set(store.listBatches().filter(b=>!['reviewing','voided'].includes(b.status)).flatMap(b=>b.jobs.map(j=>j.job_id)));
    const protectedBosses=new Set([...protectedIds].map(id=>store.getJob(id)?.boss_id).filter(Boolean));
    const reviewIds=new Set(batches.flatMap(b=>b.jobs.map(j=>j.job_id)));
    const pool=store.listJobs().filter(job=>!protectedIds.has(job.id)
      && !(job.boss_id && protectedBosses.has(job.boss_id)) && ['selected','eliminated'].includes(job.verdict)
      && !programDecision(job,{input:{expectation:store.getExpectation(job.expectation_id),params:{}}}));
    const scopeIds=new Set([...pool.map(j=>j.id),...reviewIds]),contacted=contactedBossIds();
    // Count the same existing exclusions used by reassess, including review-only references.
    const ids=store.listJobs().filter(job=>scopeIds.has(job.id) && !(job.boss_id && contacted.has(job.boss_id))
      && !programDecision(job,{input:{expectation:store.getExpectation(job.expectation_id),params:{}}})).map(job=>job.id);
    const participating=new Set(ids);
    return {job_ids:ids,pool_count:pool.filter(job=>participating.has(job.id)).length,review_count:[...reviewIds].filter(id=>participating.has(id)).length,batch_ids:batches.map(b=>b.id),batch_count:batches.length,total:ids.length};
  }
  function createRebuilds(batches,profile,parentId) {
    return batches.map(batch=>{
      const previous=store.getTask(batch.task_id);
      if(!previous?.input?.params || !previous.input.config || !previous.input.expectation)throw new Error('待审阅的投递安排缺少原任务参数，原资料与投递安排保留。');
      return save({kind:'jobs',expectation_id:batch.expectation_id,status:'queued',stop_requested:false,
        input:{params:{...copy(previous.input.params),mode:'batch'},config:copy(previous.input.config),expectation:copy(previous.input.expectation),profile:copy(profile),rebuild_parent:parentId,replaces_batch_id:batch.id},
        result:{stage:'等待重建批次',screening:{status:'not_required',job_ids:null,cache:{}},batch:{status:'pending',id:null,job_ids:[],updates:{},messages:{},refreshes:{},commute_done:{}}}}).id;
    });
  }
  async function runRebuilds(ids) {
    for(const id of ids)if(store.getTask(id)?.status==='queued')await run(id);
  }
  async function reassess({ profile, mode, taskId, signal, config = settings() }) {
    const occupied = occupiedJobIds();
    const contacted = contactedBossIds();
    const scope=mode==='introduction_rebuild'?new Set(introductionScope().job_ids):null;
    const retaining=scope && taskId && store.getTask(taskId)?.input?.mode==='introduction';
    const eligible = () => {
      const ids=scope?new Set(introductionScope().job_ids):null;
      return store.listJobs().filter(job => (ids?ids.has(job.id):!occupied.has(job.id))
      && !(job.boss_id && contacted.has(job.boss_id))
      && (scope || (mode === 'conditions' ? ['selected', 'eliminated'].includes(job.verdict) : job.verdict === 'selected'))
      && !programDecision(job, { input: { expectation: store.getExpectation(job.expectation_id), params: {} } }));
    };
    const jobs=eligible();
    const key=job=>{
      const input={introduction:profile.introduction,expectation:role(store.getExpectation(job.expectation_id)),title:job.title,tags:jobTags(job),jd:job.jd,conditions:profile.conditions || ''};
      return copy({input,config,prompt:buildPrompt('jobs.evaluate',input),schema:OUTPUT_SCHEMAS['jobs.evaluate'],route:CALL_CONFIG['jobs.evaluate']});
    };
    const updates = [];
    let reused=0;
    const report = () => {
      const state = { type: 'background', stage: scope?`正在重新评估岗位，已复用 ${reused} 岗`:'正在重新评估岗位', completed: updates.length, total: jobs.length,...(scope?{reused}: {}) };
      const task = taskId && store.getTask(taskId);
      if (task) { task.result.progress = state; save(task); }
      progress?.update?.({ taskId, name: '资料处理', status: 'running', ...state });
    };
    const pending=[];
    for(const job of jobs){
      const cached=retaining && store.getTask(taskId)?.result.preparation?.jobs?.[job.id];
      if(cached && isDeepStrictEqual(cached.key,key(job))){updates.push(evaluation(job,cached.output));reused++;}
      else pending.push(job);
    }
    report();
    await concurrent(pending, async job => {
      const expectation = store.getExpectation(job.expectation_id);
      const evaluationKey=retaining?key(job):null;
      const input = evaluationKey?.input || { introduction: profile.introduction, expectation: role(expectation), title: job.title,tags:jobTags(job), jd: job.jd, conditions: profile.conditions || '' };
      if (mode === 'conditions') {
        const check = (await agent.call({ taskId, callId: 'conditions.check', jobId: job.id,
          input: { expectation:role(expectation),title: job.title,tags:jobTags(job), jd: job.jd, conditions: profile.conditions || '' }, config, signal })).output;
        if (signal?.aborted) throw new Error('本轮资料更新已停止');
        if (check.condition_hits.length || check.direction_hits.length) { updates.push({ ...job, verdict: 'eliminated', match_level: null, matches: [], condition_hits: check.condition_hits, direction_hits:check.direction_hits }); report(); return; }
        if (job.verdict === 'selected') { updates.push({ ...job, condition_hits: [],direction_hits:check.direction_hits }); report(); return; }
      }
      const output = (await agent.call({ taskId, callId: 'jobs.evaluate', jobId: job.id, input, config, signal })).output;
      if(signal?.aborted)throw new Error('本轮资料更新已停止');
      if(retaining){
        const task=store.getTask(taskId);
        task.result.preparation.jobs[job.id]={key:evaluationKey,output};
        save(task);
      }
      updates.push(evaluation(job, output));
      report();
    }, config);
    if(retaining){
      // Merge only the evaluated fields onto currently eligible rows at publication.
      const cache=store.getTask(taskId).result.preparation.jobs;
      return eligible().map(job=>{
        if(!isDeepStrictEqual(cache[job.id]?.key,key(job)))throw new Error('岗位匹配输入已变化，请手动重试本次更新');
        return evaluation(job,cache[job.id].output);
      });
    }
    return updates;
  }
  return { start, retry, stop, pause, resume, abandon, run, reassess, introductionScope, createRebuilds, runRebuilds, occupiedJobIds, getTask: id => store.getTask(id), runners };
}
