const rules=`这是范围已经确定后的局部维护，不重新判断范围。new_sentences按原顺序给出修改后全文，是唯一当前事实依据；old_texts和affected_facts用于比较旧含义。changes是冻结的范围结果。unchanged_facts由程序完整保留，不重复输出。只处理changes覆盖的旧事实和明确新增内容；同一目标句中存在范围外内容也不得再输出它。
事实正文：内容及含义未变的旧条目，保留原正文与previous_fact_id，仅更新出处。实质改变时间/职责/主体/限定或拆合的条目，输出新事实并设previous_fact_id=null，同时把被替代旧ID列removed_fact_ids；真正删除也只列removed_fact_ids，不造替代事实。每个受影响旧ID恰好复用一次或移除一次；新事实没有旧ID。纯删除允许facts=[]。
必要背景必须进入相应事实：时间、职责、主体、否定、个人练习等限定应保留在每条受其约束的事实正文，不能另造一条背景事实代替。即使上游把时间句放在after_sentence_ids，也先辨认它是背景。背景删除不自动变成企业交付；主体同事不归本人。每条保留一个独立动作/对象/属性；共有用途不能随意分摊到各单项。语法明确的并列共享中心词应保留完整对象，不将正确补全误判为添加。
引用用source_sentence_ids：第一个是该事实的主要行为/属性所在句，其余为支持正文所需的背景句。不要只引用时间或全局限定而漏实际行为句。程序按这些句子的最小起点至最大终点恢复连续原文，不拼接；因包含背景导致引文长，不扩大生成范围。主要句用于合并排序。引用在新稿存在不等于支持正文，须检查全部含义。
不重新整理范围外历史质量，不随意改变正确旧条目的拆法或正文。特别是context_affected：旧事实的正文和拆法是本次维护的既有基准，只改变新增或变化的背景限定；原句内部的并列对象未变时，不重新解释或替换旧对象。新的背景限制不授权重审历史拆法。若新稿主动修改或否定旧对象才据变化调整；真正冲突说明unresolved，不臆测另一个对象。范围不确定或材料不足以确定修改时，用unresolved明确说明，禁止猜测；有unresolved时程序不合并。`;
const preserveRules={
  "atomize": "同句新增不等于旧事实改变。新稿仍支持的旧事实保持正文、旧ID，只更新出处；独立新增另建新条目，不揉入旧条目。只有旧含义真正改变才替换；必要主体和限定不可拆丢。\n",
  "review": "核对旧事实保留与独立新增：不因同句新增而改写正确旧条目；错合时恢复旧正文及ID，另补新增条目。恢复ID必须同步更新最终removed_fact_ids，清空用[]，null只能表示无需修改。最终每个受影响旧ID只保留或移除一次；正确项不改，主体和限定不丢。\n"
};
export function prepare(stage,sample,scope,draft){
 const oldIds=new Set(scope.changes.flatMap(c=>c.before_sentence_ids));
 const payload={new_sentences:Object.fromEntries(scope.after.map(s=>[s.id,s.text])),old_texts:Object.fromEntries(scope.before.filter(s=>oldIds.has(s.id)).map(s=>[s.id,s.text])),changes:scope.changes,affected_facts:Object.fromEntries(sample.previous_facts.filter(f=>scope.affected_ids.includes(f.fact_id)).map(f=>[f.fact_id,f.text])),unchanged_facts:Object.fromEntries(sample.previous_facts.filter(f=>scope.kept_ids.includes(f.fact_id)).map(f=>[f.fact_id,f.text]))};
 if(stage==='review')Object.assign(payload,{draft_facts:draft.facts.map((f,i)=>({draft_index:i+1,...f})),draft_removed_fact_ids:draft.removed_fact_ids,draft_unresolved:draft.unresolved??[]});
 const schema=stage==='atomize'?'{"facts":[{"previous_fact_id":"旧ID或null","text":"正文","source_sentence_ids":["主要句编号","必要背景句编号"]}],"removed_fact_ids":[],"unresolved":[]}':'{"issues":[{"draft_indices":[],"detail":"实际缺陷"}],"facts":[{"previous_fact_id":"旧ID或null","text":"正文","source_sentence_ids":[]}],"removed_fact_ids":[],"unresolved":[]}';
 const instruction=stage==='atomize'?'按冻结范围整理本次局部事实。':'核对实际局部草稿：逐组比较新旧材料，检查遗漏、限定、身份、出处、范围外重复及错误删除。正确项逐字段保持，只改有新稿依据的实质错误；修正落实到facts。issues的draft_indices只用草稿实际序号，不用句子编号。';
 const patchSchema='{"issues":[{"draft_indices":[],"detail":"实质错误及新稿依据"}],"corrections":[{"draft_index":1,"previous_fact_id":null,"text":"替换后的完整正文","source_sentence_ids":["主要句","背景句"]}],"removed_draft_indices":[],"added_facts":[],"removed_fact_ids":null,"unresolved":null}';
 const output=stage==='review'?'核对只输出必要修改，不重发正确facts。corrections按1起始草稿序号替换整条；removed_draft_indices只删除多余草稿；added_facts补遗漏，结构与原facts相同。没有修改的数组为[]；removed_fact_ids和unresolved为null表示原样继承，确需修改才给完整替换数组。每个修改须有issues对应说明；不能为了体现核对工作而改写正确项。\n输出JSON：'+patchSchema:'输出完整局部结果JSON：'+schema;
 return {input:payload,prompt:instruction+'\n'+rules+'\n'+output+'\n资料：\n'+JSON.stringify(payload)+'\n\n本轮补充规则：\n'+preserveRules[stage]};
}
