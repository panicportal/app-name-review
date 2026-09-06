const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../review/app.js'),'utf8');
function functionText(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start >= 0, name);
  const remaining = source.slice(start);
  const next = remaining.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? remaining : remaining.slice(0,next+1);
}
function element(value='') { return {value,textContent:'',dataset:{},classList:{add(){},remove(){},toggle(){}},closest(){return null}}; }
function detectionContext() {
  const state={selected:{id:'1'},cloudAuthenticated:true};
  const els={fullNameEditSurnameOrigin:element('western'),fullNameEditSurnameInput:element('Gekkou'),fullNameEditForm:element(),fullNameEditDialog:{open:true},fullNameDetectStatus:element()};
  els.fullNameEditForm.dataset.surnameLanguage='western';
  for(const key of ['Source1','Source2','Component1','Component2'])els['fullNameEdit'+key]=element();
  const context=vm.createContext({state,els,parsePastedFullName:()=>({surname:'Gekkou'}),updateFullNameEditPreview(){},originMatch:(o)=>o?.best_match,
    setSurnameEditorOriginMode(mode){els.fullNameEditSurnameOrigin.value=mode;els.fullNameEditForm.dataset.surnameLanguage=mode},
    applySurnameRepairProposal(){throw Error('Unexpected proposal')},encodeURIComponent,
    detectManualNameOrigin:async()=>({origin:'japanese',best_match:{route:'Back:Moon'}}),
    fetch:async()=>({ok:true,json:async()=>({proposals:[]})})});
  vm.runInContext(functionText('requestSurnameDetection'),context);
  return context;
}
test('explicit Western cannot be replaced by a Japanese exact-match lookup',async()=>{
  const ctx=detectionContext(); let lookups=0;
  ctx.detectManualNameOrigin=async()=>{lookups++;return {origin:'japanese'}};
  await ctx.requestSurnameDetection();
  assert.equal(lookups,0);assert.equal(ctx.els.fullNameEditSurnameOrigin.value,'western');
});
test('late detection response cannot overwrite a newer Japanese selection',async()=>{
  const ctx=detectionContext(); let release;
  ctx.fetch=()=>new Promise(r=>release=r);
  const pending=ctx.requestSurnameDetection();
  ctx.els.fullNameEditSurnameOrigin.value='japanese';
  ctx.els.fullNameDetectStatus.textContent='Keep Japanese';
  release({ok:true,json:async()=>({proposals:[{}]})});
  await pending;assert.equal(ctx.els.fullNameDetectStatus.textContent,'Keep Japanese');
});
test('unknown explicit Japanese remains atomic and does not call Western repair',async()=>{
  const ctx=detectionContext();ctx.els.fullNameEditSurnameOrigin.value='japanese';
  ctx.detectManualNameOrigin=async()=>null;ctx.fetch=()=>{throw Error('Unexpected Western repair')};
  await ctx.requestSurnameDetection();
  assert.equal(ctx.els.fullNameEditForm.dataset.surnameLanguage,'japanese');
  assert.match(ctx.els.fullNameDetectStatus.textContent,/artist-confirmed custom Japanese/);
});
test('Gekkou validation needs no Western components',()=>{
  const ctx=detectionContext();ctx.els.fullNameEditFirstInput=element('Clark');
  ctx.els.fullNameEditJapaneseSource=element('Hair:Moon candy');
  ctx.els.fullNameEditForm.dataset.surnameLanguage='japanese';
  ctx.normalizeManualFirstName=x=>x;ctx.cleanSurnameComponent=x=>x;
  vm.runInContext(functionText('fullNameEditorValue'),ctx);
  const parsed=ctx.fullNameEditorValue();assert.equal(parsed.surname,'Gekkou');assert.equal(parsed.japanese,true);assert.equal(parsed.components.length,0);
});
const {applyConfirmedRepair}=require('../api/_lib/repair-application');
const {shouldOfferRepair}=require('../api/_lib/surname-repair');
test('compound repairs preserve every existing decision and first-name record',()=>{
  const character={id:'1',first:'Clark',surname_language:'western',traits:[{type:'Back',value:'White cloud'},{type:'Mouth',value:'Big smile'}]};
  const record={parts:{first:{decision:'approve',replacement_value:'Clark'},surname_part_1:{decision:'approve',replacement_value:'Cloudsmile',replacement_language:'western'},surname_part_2:{decision:'replace',scope:'this_character',disabled:true}}};
  const state={curation:{records:{'1':structuredClone(record)}}};
  const result=applyConfirmedRepair(state,character,{surname_display:'Cloudsmile',surname_components:[{text:'Cloud',source_raw:'Back:White cloud'},{text:'Smile',source_raw:'Mouth:Big smile'}]},'QA','2026-09-05T00:00:00Z');
  assert.equal(result.applied,true);assert.deepEqual(state.curation.records['1'].parts.first,record.parts.first);
  assert.equal(state.curation.records['1'].parts.surname_part_1.decision,'approve');
  assert.equal(state.curation.records['1'].parts.surname_part_2.decision,'replace');
  assert.equal(shouldOfferRepair(character,state.curation.records['1'],state),false);
});
test('ungreenlit collapsed names are included but atomic Japanese is excluded',()=>{
  const character={surname_language:'western'};
  const record={parts:{surname_part_1:{decision:'replace',replacement_value:'Cloudsmile',replacement_language:'western'},surname_part_2:{disabled:true}}};
  assert.equal(shouldOfferRepair(character,record,{}),true);
  record.parts.surname_part_1.replacement_language='japanese';
  assert.equal(shouldOfferRepair(character,record,{}),false);
});

test('custom Japanese save survives cloud merge, JSON export, and reload',async()=>{
  const {mergeCuration}=require('../api/_lib/state');
  for(const {originOnly,locked} of [{originOnly:false,locked:false},{originOnly:true,locked:true},{originOnly:false,locked:true}]) {
    const surname=originOnly?'Gekkou':'Cloudsmile';
    const first={decision:'approve',replacement_value:'Clark',replacement_language:'western',updated_at:'2026-09-01T00:00:00Z'};
    const record={parts:{first:structuredClone(first),surname_part_1:{decision:locked?'approve':'replace',replacement_value:surname,replacement_language:'western'},surname_part_2:{decision:locked?'approve':'replace',disabled:true}}};
    const state={selected:{id:'1',first:'Clark',clothing:'Common villager',gender_from_body:'Male'},curation:{schema_version:'panic-name-curation/v2',records:{'1':record}},cloudAuthenticated:true,cloudDirty:false,surnameRepairIndex:{}};
    const els={fullNameEditFirstInput:element('Clark'),fullNameEditSurnameInput:element('Gekkou'),fullNameEditFirstOrigin:element('western'),fullNameEditSurnameOrigin:element('japanese'),fullNameEditJapaneseSource:element('Hair:Moon candy'),fullNameEditConfirmLockedSurname:{checked:locked},fullNameEditForm:element(),fullNameEditStatus:element(),fullNameEditSource1:element(),fullNameEditDialog:{close(){}}};
    els.fullNameEditForm.dataset={originalFirstOrigin:'western',originalSurnameOrigin:'western'};
    let synced;
    const ctx=vm.createContext({state,els,normalizeManualFirstName:x=>x,effectivePartValue:()=> 'Clark',effectiveSurname:()=>surname,detectManualNameOrigin:async()=>null,originMatch:()=>null,
      setFirstEditorOriginMode(){},setSurnameEditorOriginMode(){},updateFullNameEditPreview:()=>({first:'Clark',surname:'Gekkou',japanese:true,japanese_source:'Hair:Moon candy',order:'12',components:[]}),
      partReview:(_,k)=>record.parts[k]||{},nowIso:()=> '2026-09-05T00:00:00Z',ensureRecord:()=>record,SURNAME_FORMAT_VERSION:3,
      saveCuration(){state.cloudDirty=true},async pushCloudState(){synced=mergeCuration({schema_version:'panic-name-curation/v2',records:{}},state.curation);state.cloudDirty=false},
      renderCharacter(){},updateProgress(){},renderRoster(){},effectiveDisplayName:()=> 'Clark Gekkou',showToast(){}});
    vm.runInContext(functionText('saveFullNameEdit'),ctx);
    await ctx.saveFullNameEdit({preventDefault(){}});
    const reloaded=JSON.parse(JSON.stringify(synced));
    const saved=reloaded.records['1'];assert.deepEqual(saved.parts.first,first);
    assert.equal(saved.parts.surname_part_1.replacement_language,'japanese');
    assert.equal(saved.parts.surname_part_1.replacement_origin_kind,'artist_custom');
    assert.equal(saved.parts.surname_part_1.replacement_value,'Gekkou');
    assert.equal(saved.parts.surname_part_2.disabled,true);
    assert.equal(saved.parts.surname_part_1.decision,locked?'approve':'replace');
    assert.equal(saved.parts.surname_part_2.decision,locked&&!originOnly?null:locked?'approve':'replace');
    assert.equal(saved.parts.surname_part_1.replacement_trait_source,'Hair:Moon candy');
    if(locked&&!originOnly) assert.equal(saved.manual_name_edit_history.at(-1).action,'replace_confirmed_surname');
  }
});

test('concurrent cloud save retries merge against latest revision',async()=>{
  const handlerSource=fs.readFileSync(require('node:path').join(__dirname,'../api/state.js'),'utf8');
  const stateLib=require('../api/_lib/state');
  let stored={revision:1,curation:{schema_version:'panic-name-curation/v2',records:{},updated_at:null}};
  let attempts=0;
  const ctx=vm.createContext({module:{exports:{}},require(name){
    if(name==='./_lib/auth')return {requireSession:()=>({name:'QA'})};
    if(name==='./_lib/state')return {...stateLib,getOrCreateState:async()=>structuredClone(stored)};
    if(name==='./_lib/store')return {compareAndSwapState:async(revision,next)=>{
      attempts++;
      if(attempts===1){stored.revision++;stored.curation.records['2']={parts:{first:{decision:'approve',replacement_language:'japanese',replacement_value:'Aiko',updated_at:'2026-09-05T00:00:01Z'}}};return false}
      assert.equal(revision,stored.revision);stored=next;return true;
    }};
    throw Error(name);
  }});
  vm.runInContext(handlerSource,ctx);
  const response={setHeader(){},status(code){this.code=code;return this},json(data){this.data=data;return this}};
  const incoming={schema_version:'panic-name-curation/v2',records:{'1':{parts:{surname_part_1:{replacement_value:'Gekkou',replacement_language:'japanese',replacement_origin_kind:'artist_custom',updated_at:'2026-09-05T00:00:02Z'}}}}};
  await ctx.module.exports({method:'PUT',body:{curation:incoming}},response);
  assert.equal(response.code,200);assert.equal(attempts,2);
  assert.equal(stored.curation.records['2'].parts.first.replacement_value,'Aiko');
  assert.equal(stored.curation.records['1'].parts.surname_part_1.replacement_value,'Gekkou');
});
