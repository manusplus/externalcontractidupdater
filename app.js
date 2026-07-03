(function(){
  const SESSION_KEY='manus_contract_updater_session';
  const $=id=>document.getElementById(id);
  const els={endpoint:$('endpoint'),client:$('client'),instance:$('instance'),username:$('username'),password:$('password'),baseUrl:$('baseUrl'),authStatus:$('authStatus'),nodeSelect:$('nodeSelect'),salaryGroupSelect:$('salaryGroupSelect'),salaryPeriodSelect:$('salaryPeriodSelect'),yearInput:$('yearInput'),btnLogin:$('btnLogin'),btnLogout:$('btnLogout'),btnLoadContracts:$('btnLoadContracts'),loadStatus:$('loadStatus'),csvText:$('csvText'),csvFile:$('csvFile'),btnParseCsv:$('btnParseCsv'),csvStatus:$('csvStatus'),filterSearch:$('filterSearch'),filterInfo:$('filterInfo'),filterSelectedOnly:$('filterSelectedOnly'),filterUpdateableOnly:$('filterUpdateableOnly'),nodeFilterList:$('nodeFilterList'),nodeFilterSummary:$('nodeFilterSummary'),btnNodeAll:$('btnNodeAll'),btnNodeNone:$('btnNodeNone'),btnSelectFiltered:$('btnSelectFiltered'),btnDeselectFiltered:$('btnDeselectFiltered'),btnClearFilters:$('btnClearFilters'),selectAll:$('selectAll'),summaryCounts:$('summaryCounts'),previewBody:document.querySelector('#previewTable tbody'),btnRunDry:$('btnRunDry'),btnRunUpdate:$('btnRunUpdate'),btnExportAudit:$('btnExportAudit'),btnExportPreviewExcel:$('btnExportPreviewExcel'),progress:$('progress'),progressText:$('progressText'),updateStatus:$('updateStatus'),auditLog:$('auditLog')};
  const state={token:null,expiresAt:0,nodes:[],salaryGroups:[],salaryPeriods:[],contracts:[],csvRows:[],csvByRegisterId:new Map(),previewRows:[],visibleRows:[],nodeFilterSelected:new Set(),nodeCodeList:[],audit:[]};
  const MAX_PARALLEL_PUTS=3; // Run up to 3 employees in parallel; contract rows for the same employee are still processed sequentially.
  const MIN_STAGGER_MS=250;
  const MAX_STAGGER_MS=500;

  function setStatus(el,msg,level){el.textContent=msg||'';el.className='status '+(level||'');}
  function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  function randomStagger(){return Math.floor(MIN_STAGGER_MS+Math.random()*(MAX_STAGGER_MS-MIN_STAGGER_MS+1));}
  function normalizeSegment(s){return String(s||'').trim().replace(/^\/+|\/+$/g,'');}
  function isLive(){return els.endpoint.value.includes('server.manus.plus')&&!els.endpoint.value.includes('server-test')&&!els.endpoint.value.includes('server-demo');}
  function buildBasePath(){const origin=String(els.endpoint.value||'').trim().replace(/\/+$/,'');const client=normalizeSegment(els.client.value);const inst=normalizeSegment(els.instance.value);if(!origin)return'';if(!client)return origin;if(isLive())return origin+'/'+client;return inst?origin+'/'+client+'/'+inst:origin+'/'+client;}
  function updateBase(){els.baseUrl.textContent=buildBasePath()||'-';}
  function saveSession(x){try{x?localStorage.setItem(SESSION_KEY,JSON.stringify(x)):localStorage.removeItem(SESSION_KEY)}catch(e){}}
  function readSession(){try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch(e){return null}}
  function authHeaders(extra){if(!state.token)throw new Error('Not authenticated');if(state.expiresAt&&state.expiresAt<Date.now())throw new Error('Token expired. Log in again.');return Object.assign({Authorization:'Bearer '+state.token,Accept:'application/json'},extra||{});}
  async function fetchJson(url,options){const resp=await fetch(url,options||{});const text=await resp.text();let json=null;try{json=text?JSON.parse(text):null}catch(e){}if(!resp.ok){const msg=json&&(json.message||json.error||json.detail);throw new Error('HTTP '+resp.status+(msg?' - '+msg:text?' - '+text.slice(0,300):''));}return json;}
  function localTodayYear(){return new Date().getFullYear();}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
  function getContractId(c){return c.contractId||c.id||c.contractID||'';}
  function getFrom(c){return c.fromDate||c.from||c.fromdate||'';}
  function getTill(c){return c.tillDate||c.toDate||c.to||c.tilldate||'';}

  async function login(){
    try{
      updateBase(); setStatus(els.authStatus,'Logging in...','');
      const base=buildBasePath(); if(!base)throw new Error('Fill endpoint, client, and instance when required.');
      const body=new URLSearchParams();body.set('grant_type','password');body.set('username',els.username.value);body.set('password',els.password.value);
      const json=await fetchJson(base+'/app/token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
      const token=json&&(json.access_token||json.token||json.accessToken); if(!token)throw new Error('No access_token in token response.');
      const exp=json.expires_in?Date.now()+Number(json.expires_in)*1000:0;
      state.token=token; state.expiresAt=exp; saveSession({token,expiresAt:exp,scope:base});
      setStatus(els.authStatus,'Authenticated. Loading nodes...','ok');
      await loadNodes();
      setStatus(els.authStatus,'Authenticated.','ok');
    }catch(e){setStatus(els.authStatus,e.message,'danger');}
  }
  function logout(){state.token=null;state.expiresAt=0;saveSession(null);state.nodes=[];state.salaryGroups=[];state.salaryPeriods=[];state.contracts=[];state.previewRows=[];renderNodeOptions();renderPreview();setStatus(els.authStatus,'Logged out.','');}

  function flattenNodeTree(root){const out=[];const stack=[{node:root,depth:0}];while(stack.length){const {node,depth}=stack.pop();if(!node||typeof node!=='object')continue;const id=node.nodeId||node.id;if(id)out.push({nodeId:id,code:node.code||node.nodeCode||'',name:node.name||node.nodeName||'',accessible:node.accessible!==false,depth});const kids=Array.isArray(node.items)?node.items:[];for(let i=kids.length-1;i>=0;i--)stack.push({node:kids[i],depth:depth+1});}return out;}
  async function loadNodes(){const base=buildBasePath();const data=await fetchJson(base+'/api/user/node-tree',{headers:authHeaders()});state.nodes=flattenNodeTree(data).filter(n=>n.accessible);renderNodeOptions();}
  function renderNodeOptions(){els.nodeSelect.innerHTML='';if(!state.token){els.nodeSelect.disabled=true;els.nodeSelect.innerHTML='<option value="">Log in first</option>';return;}els.nodeSelect.disabled=false;els.nodeSelect.innerHTML='<option value="">Select node</option>';state.nodes.forEach(n=>{const o=document.createElement('option');o.value=n.nodeId;o.textContent='   '.repeat(n.depth)+(n.code?'['+n.code+'] ':'')+n.name+' - '+n.nodeId;els.nodeSelect.appendChild(o);});}

  function normList(data){return Array.isArray(data)?data:(data&&Array.isArray(data.items)?data.items:(data&&Array.isArray(data.data)?data.data:[]));}
  async function loadSalaryGroups(){
    const nodeId=els.nodeSelect.value; if(!nodeId)return;
    setStatus(els.loadStatus,'Loading salary groups...','');
    const data=await fetchJson(buildBasePath()+'/api/node/'+encodeURIComponent(nodeId)+'/salary-group/',{headers:authHeaders()});
    state.salaryGroups=normList(data).map(x=>({id:String(x.id??x.salaryGroupId??''),code:String(x.code??''),name:String(x.name??x.description??''),active:x.isActive!==false})).filter(x=>x.id&&x.active);
    if(!state.salaryGroups.some(x=>x.id==='0'))state.salaryGroups.unshift({id:'0',code:'0',name:'Default',active:true});
    els.salaryGroupSelect.disabled=false;els.salaryGroupSelect.innerHTML='<option value="">Select salary group</option>';
    state.salaryGroups.forEach(g=>{const o=document.createElement('option');o.value=g.id;o.textContent=(g.code?'['+g.code+'] ':'')+(g.name||'Salary group')+' - '+g.id;els.salaryGroupSelect.appendChild(o);});
    setStatus(els.loadStatus,'Salary groups loaded.','ok');
  }
  async function loadSalaryPeriods(){
    const nodeId=els.nodeSelect.value, groupId=els.salaryGroupSelect.value, year=els.yearInput.value; if(!nodeId||!groupId||!year)return;
    setStatus(els.loadStatus,'Loading salary periods...','');
    const url=buildBasePath()+'/api/node/'+encodeURIComponent(nodeId)+'/salary-period/'+encodeURIComponent(groupId)+'/'+encodeURIComponent(year)+'/';
    const data=await fetchJson(url,{headers:authHeaders()});
    state.salaryPeriods=normList(data).map(x=>({id:String(x.id??x.salaryPeriodId??''),name:String(x.name??x.description??''),fromDate:String(x.fromDate??x.startDate??''),toDate:String(x.toDate??x.endDate??'')})).filter(x=>x.id);
    els.salaryPeriodSelect.disabled=false;els.salaryPeriodSelect.innerHTML='<option value="">Select salary period</option>';
    state.salaryPeriods.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.dataset.fromDate=p.fromDate;o.textContent=(p.name?p.name+' - ':'')+(p.fromDate||'?')+' to '+(p.toDate||'?')+' - '+p.id;els.salaryPeriodSelect.appendChild(o);});
    setStatus(els.loadStatus,'Salary periods loaded.','ok');
    updateLoadButton();
  }
  function selectedPeriod(){return state.salaryPeriods.find(p=>p.id===els.salaryPeriodSelect.value)||null;}
  function updateLoadButton(){els.btnLoadContracts.disabled=!(state.token&&els.nodeSelect.value&&selectedPeriod());}
  async function loadContracts(){
    try{
      const nodeId=els.nodeSelect.value; const p=selectedPeriod(); if(!p||!p.fromDate)throw new Error('Selected salary period has no fromDate.');
      const url=buildBasePath()+'/api/node/'+encodeURIComponent(nodeId)+'/contract/?subtree=true&fromDate='+encodeURIComponent(p.fromDate)+'&toDate=9999-12-31';
      setStatus(els.loadStatus,'Loading contracts from '+p.fromDate+' to 9999-12-31...','');
      const data=await fetchJson(url,{headers:authHeaders()});
      state.contracts=normList(data);
      setStatus(els.loadStatus,'Loaded '+state.contracts.length+' contract records.','ok');
      buildPreview();
    }catch(e){setStatus(els.loadStatus,e.message,'danger');}
  }

  function parseCsvText(text){
    const rows=[]; const dup=[]; const seen=new Set();
    String(text||'').split(/\r?\n/).forEach((line,idx)=>{const raw=line.trim();if(!raw)return;const p=raw.split(';').map(x=>x.trim());if(p.length<4){rows.push({line:idx+1,error:'Expected 4 columns',raw});return;}const reg=p[0],oldValue=p[1],reg2=p[2],newValue=p[3];if(reg!==reg2)rows.push({line:idx+1,registerId:reg,oldValue,newValue,error:'RegisterId columns differ'});else rows.push({line:idx+1,registerId:reg,oldValue,newValue});if(seen.has(reg))dup.push(reg);seen.add(reg);});
    state.csvRows=rows; state.csvByRegisterId=new Map(); rows.filter(r=>!r.error&&r.registerId&&r.newValue!==undefined).forEach(r=>state.csvByRegisterId.set(String(r.registerId),r));
    return {rows,dup:Array.from(new Set(dup))};
  }
  function parseCsv(){const res=parseCsvText(els.csvText.value);const errors=res.rows.filter(r=>r.error).length;let msg='Parsed '+res.rows.length+' CSV rows; usable registerIds: '+state.csvByRegisterId.size+'.';if(errors)msg+=' Errors: '+errors+'.';if(res.dup.length)msg+=' Duplicate registerIds: '+res.dup.length+' (last value wins).';setStatus(els.csvStatus,msg,errors?'warn':'ok');buildPreview();}

  function buildPreview(){
    state.previewRows=state.contracts.map((c,i)=>{const reg=String(c.registerId??'');const csv=state.csvByRegisterId.get(reg);const current=String(c.externalContractId??'');let info='No CSV match', level='danger', updateable=false;if(csv){updateable=true;info=current===String(csv.oldValue)?'OK':'Old value differs';level=current===String(csv.oldValue)?'ok':'warn';}
      return {index:i,selected:false,updateable,contract:c,registerId:reg,nodeCode:c.nodeCode||'',nodeName:c.nodeName||'',employeeId:c.employeeId||'',contractId:getContractId(c),fromDate:getFrom(c),tillDate:getTill(c),current,csvOld:csv?csv.oldValue:'',csvNew:csv?csv.newValue:'',info,level};});
    rebuildNodeCodeList();
    state.nodeFilterSelected.clear();
    state.nodeCodeList.forEach(([code])=>state.nodeFilterSelected.add(code));
    renderNodeFilter();
    renderPreview();
  }

  function rebuildNodeCodeList(){
    const map=new Map();
    state.previewRows.forEach(r=>{const code=String(r.nodeCode||'').trim();if(!code)return;if(!map.has(code))map.set(code,r.nodeName||'');});
    state.nodeCodeList=Array.from(map.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  }
  function uniqueNodeCodes(){return state.nodeCodeList||[];}
  function hasActiveNodeFilter(){
    const total=state.nodeCodeList.length;
    return total>0 && state.nodeFilterSelected.size!==total;
  }

  function updateNodeFilterSummary(totalNodes){
    if(!els.nodeFilterSummary)return;
    const total=typeof totalNodes==='number'?totalNodes:uniqueNodeCodes().length;
    const selected=state.nodeFilterSelected.size;
    els.nodeFilterSummary.textContent=selected===total?'All nodes':(selected===0?'No nodes':(selected+' of '+total+' nodes'));
  }

  function renderNodeFilter(){
    if(!els.nodeFilterList)return;
    const nodes=uniqueNodeCodes();
    els.nodeFilterList.innerHTML='';
    nodes.forEach(([code,name])=>{
      const label=document.createElement('label');label.className='node-filter-option';
      const cb=document.createElement('input');cb.type='checkbox';cb.checked=state.nodeFilterSelected.has(code);
      cb.addEventListener('change',()=>{if(cb.checked)state.nodeFilterSelected.add(code);else state.nodeFilterSelected.delete(code);renderPreview();});
      const span=document.createElement('span');span.textContent=code+(name?' - '+name:'');
      label.appendChild(cb);label.appendChild(span);els.nodeFilterList.appendChild(label);
    });
    updateNodeFilterSummary(nodes.length);
  }

  function rowMatchesFilters(r){
    const q=String(els.filterSearch&&els.filterSearch.value||'').trim().toLowerCase();
    if(q){const hay=[r.registerId,r.nodeCode,r.nodeName,r.employeeId,r.contractId,r.fromDate,r.tillDate,r.current,r.csvOld,r.csvNew,r.info].join(' ').toLowerCase();if(!hay.includes(q))return false;}
    const info=String(els.filterInfo&&els.filterInfo.value||'');if(info&&r.info!==info)return false;
    if(els.filterSelectedOnly&&els.filterSelectedOnly.checked&&!r.selected)return false;
    if(els.filterUpdateableOnly&&els.filterUpdateableOnly.checked&&!r.updateable)return false;
    if(hasActiveNodeFilter()){const code=String(r.nodeCode||'').trim();if(!state.nodeFilterSelected.has(code))return false;}
    return true;
  }
  function filteredRows(){return state.previewRows.filter(rowMatchesFilters);}

  function renderPreview(){
    els.previewBody.innerHTML='';
    const visible=filteredRows();state.visibleRows=visible;
    const frag=document.createDocumentFragment();
    visible.forEach((r)=>{const tr=document.createElement('tr');tr.innerHTML='<td></td><td>'+esc(r.registerId)+'</td><td>'+esc(r.nodeCode)+'</td><td>'+esc(r.nodeName)+'</td><td>'+esc(r.employeeId)+'</td><td>'+esc(r.contractId)+'</td><td>'+esc(r.fromDate)+'</td><td>'+esc(r.tillDate)+'</td><td>'+esc(r.current)+'</td><td>'+esc(r.csvOld)+'</td><td>'+esc(r.csvNew)+'</td><td class="info-'+r.level+'">'+esc(r.info)+'</td>';const cb=document.createElement('input');cb.type='checkbox';cb.disabled=!r.updateable;cb.checked=!!r.selected;cb.addEventListener('change',()=>{r.selected=cb.checked;renderPreviewControls();});tr.children[0].appendChild(cb);frag.appendChild(tr);});
    els.previewBody.appendChild(frag);
    renderPreviewControls();
  }
  function renderPreviewControls(){
    const updateable=state.previewRows.filter(r=>r.updateable).length;
    const selected=state.previewRows.filter(r=>r.selected).length;
    const total=state.previewRows.length;
    const visible=state.visibleRows.length;
    const visibleUpdateable=state.visibleRows.filter(r=>r.updateable).length;
    const visibleSelected=state.visibleRows.filter(r=>r.selected).length;
    els.summaryCounts.textContent=total+' contracts loaded; '+updateable+' matched CSV; '+selected+' selected for update. Visible: '+visible+'; visible updateable: '+visibleUpdateable+'; visible selected: '+visibleSelected+'.';
    els.selectAll.checked=updateable>0&&selected===updateable;
    els.btnRunDry.disabled=selected===0;els.btnRunUpdate.disabled=selected===0;
    if(els.btnExportPreviewExcel)els.btnExportPreviewExcel.disabled=total===0;
    updateNodeFilterSummary();
  }

  function putUrlFor(c){
    const nodeId=String(els.nodeSelect.value||'').trim();
    const employeeId=String(c.employeeId||'').trim();
    if(!nodeId) throw new Error('No nodeId selected');
    if(!employeeId) throw new Error('Contract has no employeeId; PUT not sent');
    // Important: use the regular contract PUT endpoint, without /{contractId}.
    // contractId remains informational/audit data and remains in the full payload if returned by GET.
    return buildBasePath()+'/api/node/'+encodeURIComponent(nodeId)+'/employee/'+encodeURIComponent(employeeId)+'/contract';
  }
  function appendAuditLine(text){els.auditLog.textContent+=text+'\n';els.auditLog.scrollTop=els.auditLog.scrollHeight;}
  async function runUpdates(dry){
    const rows=state.previewRows.filter(r=>r.updateable && r.selected === true);
    const visibleSelected=(state.visibleRows||[]).filter(r=>r.updateable && r.selected === true).length;
    if(!rows.length){setStatus(els.updateStatus,'No selected updateable rows. Use the row checkboxes or Select filtered first.','warn');return;}
    if(!dry){
      const hiddenSelected=rows.length-visibleSelected;
      const msg='Update '+rows.length+' selected contract record(s)?'+(hiddenSelected>0?'\n\nNote: '+hiddenSelected+' selected row(s) are currently hidden by filters and will also be updated.':'');
      if(!window.confirm(msg))return;
    }
    state.audit=[];els.auditLog.textContent='';els.progress.value=0;els.progressText.textContent='0%';
    setStatus(els.updateStatus,(dry?'Dry run':'Update')+' started for '+rows.length+' contracts. Max parallel employees: '+MAX_PARALLEL_PUTS+'; stagger '+MIN_STAGGER_MS+'-'+MAX_STAGGER_MS+' ms before PUT start.','');
    els.btnRunDry.disabled=true;els.btnRunUpdate.disabled=true;
    let done=0,failed=0,started=0;
    const runStartedAt=Date.now();
    const durations=[];

    function formatDuration(ms){
      if(!isFinite(ms)||ms<0)return '-';
      const sec=Math.round(ms/1000);
      const h=Math.floor(sec/3600);
      const m=Math.floor((sec%3600)/60);
      const s=sec%60;
      if(h)return h+'h '+String(m).padStart(2,'0')+'m';
      if(m)return m+'m '+String(s).padStart(2,'0')+'s';
      return s+'s';
    }

    function updateProgress(){
      const pct=rows.length?Math.round(done/rows.length*100):100;
      const active=Math.max(0,started-done);
      const elapsedMs=Date.now()-runStartedAt;
      const throughput=elapsedMs>0?Math.round(done/(elapsedMs/3600000)):0;
      const avgMs=durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:0;
      const remaining=rows.length-done;
      const etaMs=done>0?(elapsedMs/done)*remaining:0;
      els.progress.value=pct;
      els.progressText.textContent=pct+'% - remaining '+remaining+' - active '+active+' - '+throughput+'/hour - ETA '+(done?formatDuration(etaMs):'-');
      if(done>0){
        setStatus(els.updateStatus,'Running regular PUTs: '+done+'/'+rows.length+' completed, '+active+' active, max '+MAX_PARALLEL_PUTS+', stagger '+MIN_STAGGER_MS+'-'+MAX_STAGGER_MS+' ms, avg PUT '+(avgMs?formatDuration(avgMs):'-')+', throughput '+throughput+'/hour, ETA '+formatDuration(etaMs)+'.','');
      }
    }

    async function processRow(r){
      started++;
      const rowStartedAt=Date.now();
      const payload=Object.assign({},r.contract);
      payload.externalContractId=r.csvNew;
      const audit={time:new Date().toISOString(),dryRun:dry,registerId:r.registerId,nodeCode:r.nodeCode,nodeName:r.nodeName,employeeId:r.employeeId,contractId:r.contractId,fromDate:r.fromDate,tillDate:r.tillDate,oldExternalContractId:r.current,csvOld:r.csvOld,newExternalContractId:r.csvNew,status:'',message:''};
      try{
        const putUrl=putUrlFor(r.contract);
        audit.url=putUrl;
        if(dry){
          audit.status='DRY_RUN';
          audit.message='No request sent. Would regular PUT without contractId in URL: '+putUrl;
          appendAuditLine('DRY_RUN | '+audit.registerId+' | '+audit.contractId+' | regular PUT '+putUrl);
        }
        else{
          appendAuditLine('SENDING REGULAR PUT | '+audit.registerId+' | '+audit.contractId+' | '+putUrl);
          console.log('MANUS contract updater regular PUT without contractId in URL', putUrl, payload);
          setStatus(els.updateStatus,'Running regular PUTs: '+done+'/'+rows.length+' completed, '+Math.max(0,started-done)+' active, max '+MAX_PARALLEL_PUTS+', stagger '+MIN_STAGGER_MS+'-'+MAX_STAGGER_MS+' ms.','');
          const resp=await fetch(putUrl,{
            method:'PUT',
            headers:authHeaders({'Content-Type':'application/json'}),
            body:JSON.stringify(payload)
          });
          const text=await resp.text();
          if(!resp.ok)throw new Error('HTTP '+resp.status+(text?' - '+text.slice(0,300):''));
          audit.status='UPDATED';audit.message='HTTP '+resp.status+' OK';
          appendAuditLine('UPDATED | '+audit.registerId+' | '+audit.contractId+' | HTTP '+resp.status);
        }
      }catch(e){
        failed++;audit.status='FAILED';audit.message=e.message;
        appendAuditLine('FAILED | '+audit.registerId+' | '+audit.contractId+' | '+audit.message);
      }finally{
        durations.push(Date.now()-rowStartedAt);
        if(durations.length>100)durations.shift();
        done++;state.audit.push(audit);updateProgress();
      }
    }

    try{
      // Group by employee/registerId so multiple contract records for the same employee are not PUT at the same time.
      const groups=[];
      const byEmployee=new Map();
      rows.forEach(r=>{
        const key=String(r.employeeId||r.registerId||r.index);
        if(!byEmployee.has(key)){byEmployee.set(key,[]);groups.push(byEmployee.get(key));}
        byEmployee.get(key).push(r);
      });

      let groupIndex=0;
      async function worker(workerId){
        // Stagger worker startup so the first 3 PUTs are not fired on the same millisecond.
        if(workerId>1){
          const initialDelay=randomStagger()*(workerId-1);
          appendAuditLine('WORKER '+workerId+' | initial stagger '+initialDelay+' ms');
          await sleep(initialDelay);
        }
        while(groupIndex<groups.length){
          const group=groups[groupIndex++];
          for(const r of group){
            const delay=randomStagger();
            appendAuditLine('WAIT '+delay+' ms | '+r.registerId+' | '+r.contractId);
            await sleep(delay);
            await processRow(r);
          }
        }
      }

      const workerCount=Math.min(MAX_PARALLEL_PUTS,groups.length || 1);
      appendAuditLine('START | '+rows.length+' contracts | '+groups.length+' employee/register groups | max parallel groups '+workerCount+' | stagger '+MIN_STAGGER_MS+'-'+MAX_STAGGER_MS+' ms');
      await Promise.all(Array.from({length:workerCount},(_,i)=>worker(i+1)));
      setStatus(els.updateStatus,(dry?'Dry run':'Update')+' completed. Success: '+(rows.length-failed)+', failed: '+failed+'.',failed?'warn':'ok');
    }finally{
      renderPreviewControls();
      els.btnExportAudit.disabled=state.audit.length===0;
    }
  }
  function tableHtmlForExcel(tableEl){
    const clone=tableEl.cloneNode(true);
    // Replace checkbox cells by Yes/No so Excel contains useful values.
    const bodyRows=clone.querySelectorAll('tbody tr');
    bodyRows.forEach((tr,rowIndex)=>{
      const sourceRow=state.visibleRows[rowIndex];
      const first=tr.children[0];
      if(first && sourceRow){
        first.textContent=sourceRow.selected?'Yes':'No';
      }
    });
    return '<table border="1">'+clone.innerHTML+'</table>';
  }

  function exportPreviewExcel(){
    const table=document.getElementById('previewTable');
    if(!table || !state.previewRows.length)return;
    const html='<!doctype html><html><head><meta charset="utf-8"></head><body>'+tableHtmlForExcel(table)+'</body></html>';
    const blob=new Blob([html],{type:'application/vnd.ms-excel;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const ts=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    a.href=url;
    a.download='manus_contract_preview_'+ts+'.xls';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportAudit(){const header=['time','dryRun','registerId','nodeCode','nodeName','employeeId','contractId','fromDate','tillDate','oldExternalContractId','csvOld','newExternalContractId','status','message','url'];const lines=['sep=;',header.join(';')];state.audit.forEach(a=>lines.push(header.map(k=>'"'+String(a[k]??'').replace(/"/g,'""')+'"').join(';')));const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='manus_contract_update_audit.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);}

  function debounce(fn,ms){let timer=null;return function(){clearTimeout(timer);timer=setTimeout(fn,ms);};}
  const renderPreviewDebounced=debounce(renderPreview,150);

  els.btnLogin.addEventListener('click',login);els.btnLogout.addEventListener('click',logout);
  [els.endpoint,els.client,els.instance].forEach(e=>e.addEventListener('input',updateBase));
  els.nodeSelect.addEventListener('change',async()=>{els.salaryGroupSelect.disabled=true;els.salaryGroupSelect.innerHTML='<option value="">Loading...</option>';els.salaryPeriodSelect.disabled=true;els.salaryPeriodSelect.innerHTML='<option value="">Select group/year first</option>';state.salaryPeriods=[];updateLoadButton();try{await loadSalaryGroups()}catch(e){setStatus(els.loadStatus,e.message,'danger')}});
  els.salaryGroupSelect.addEventListener('change',async()=>{try{await loadSalaryPeriods()}catch(e){setStatus(els.loadStatus,e.message,'danger')}});
  els.yearInput.addEventListener('change',async()=>{if(els.salaryGroupSelect.value)try{await loadSalaryPeriods()}catch(e){setStatus(els.loadStatus,e.message,'danger')}});
  els.salaryPeriodSelect.addEventListener('change',updateLoadButton);els.btnLoadContracts.addEventListener('click',loadContracts);
  els.csvFile.addEventListener('change',async()=>{const f=els.csvFile.files&&els.csvFile.files[0];if(f){els.csvText.value=await f.text();parseCsv();}});els.btnParseCsv.addEventListener('click',parseCsv);
  els.selectAll.addEventListener('change',()=>{state.previewRows.forEach(r=>{if(r.updateable)r.selected=els.selectAll.checked});renderPreview();});
  if(els.filterSearch)els.filterSearch.addEventListener('input',renderPreviewDebounced);
  if(els.filterInfo)els.filterInfo.addEventListener('change',renderPreview);
  if(els.filterSelectedOnly)els.filterSelectedOnly.addEventListener('change',renderPreview);
  if(els.filterUpdateableOnly)els.filterUpdateableOnly.addEventListener('change',renderPreview);
  if(els.btnSelectFiltered)els.btnSelectFiltered.addEventListener('click',()=>{filteredRows().forEach(r=>{if(r.updateable)r.selected=true});renderPreview();});
  if(els.btnDeselectFiltered)els.btnDeselectFiltered.addEventListener('click',()=>{filteredRows().forEach(r=>{if(r.updateable)r.selected=false});renderPreview();});
  if(els.btnClearFilters)els.btnClearFilters.addEventListener('click',()=>{if(els.filterSearch)els.filterSearch.value='';if(els.filterInfo)els.filterInfo.value='';if(els.filterSelectedOnly)els.filterSelectedOnly.checked=false;if(els.filterUpdateableOnly)els.filterUpdateableOnly.checked=false;state.nodeFilterSelected.clear();uniqueNodeCodes().forEach(([code])=>state.nodeFilterSelected.add(code));renderNodeFilter();renderPreview();});
  if(els.btnNodeAll)els.btnNodeAll.addEventListener('click',()=>{state.nodeFilterSelected.clear();uniqueNodeCodes().forEach(([code])=>state.nodeFilterSelected.add(code));renderNodeFilter();renderPreview();});
  if(els.btnNodeNone)els.btnNodeNone.addEventListener('click',()=>{state.nodeFilterSelected.clear();renderNodeFilter();renderPreview();});
  els.btnRunDry.addEventListener('click',()=>runUpdates(true));els.btnRunUpdate.addEventListener('click',()=>runUpdates(false));if(els.btnExportPreviewExcel)els.btnExportPreviewExcel.addEventListener('click',exportPreviewExcel);els.btnExportAudit.addEventListener('click',exportAudit);

  function init(){els.yearInput.value=localTodayYear();updateBase();const s=readSession();if(s&&s.token&&s.scope===buildBasePath()){state.token=s.token;state.expiresAt=s.expiresAt||0;setStatus(els.authStatus,'Authenticated from saved session. Loading nodes...','ok');loadNodes().then(()=>setStatus(els.authStatus,'Authenticated from saved session.','ok')).catch(e=>setStatus(els.authStatus,e.message,'warn'));}}
  init();
})();
