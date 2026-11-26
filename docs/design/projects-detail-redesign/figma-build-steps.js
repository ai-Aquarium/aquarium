// Figma Plugin API script that drew the Requirements, Plan, Cards (Kanban, Graph) and Compare runs
// screens in https://www.figma.com/design/2ulo0wiREINRTTsynkpkgl. Each screen clones the Runs frame (1:2)
// drawn by figma-build-script.js and replaces its workspace and agent messages, so run that first.
// Run through the Figma MCP `use_figma` tool. The `return` lines were separate calls; run each part on its own.

// ===== part 1: helpers + Requirements + Plan =====
// Shared helpers: same primitives as figma-build-script.js, plus screen cloning from the Runs frame (1:2).
await Promise.all(['Regular','Medium','Semi Bold','Bold'].map(s=>figma.loadFontAsync({family:'Inter',style:s})));
const hex=h=>{h=h.replace('#','');return {r:parseInt(h.slice(0,2),16)/255,g:parseInt(h.slice(2,4),16)/255,b:parseInt(h.slice(4,6),16)/255}};
const solid=(h,o=1)=>[{type:'SOLID',color:hex(h),opacity:o}];
const C={bg:'#0b0d12',s1:'#141821',s2:'#1c2230',bd:'#262d3a',tx:'#e6e9ef',mu:'#8b93a7',ac:'#5b8cff',wa:'#f59e0b',wt:'#fcd34d',ok:'#34d399',dg:'#f87171'};
function box(name,dir='VERTICAL',o={}){const f=figma.createFrame();f.name=name;f.layoutMode=dir;f.primaryAxisSizingMode='AUTO';f.counterAxisSizingMode='AUTO';f.itemSpacing=o.gap??0;const p=o.pad??0;if(Array.isArray(p)){f.paddingTop=p[0];f.paddingRight=p[1];f.paddingBottom=p[2];f.paddingLeft=p[3]}else{f.paddingTop=f.paddingRight=f.paddingBottom=f.paddingLeft=p}f.fills=o.fill?solid(o.fill,o.fo??1):[];if(o.stroke){f.strokes=solid(o.stroke,o.so??1);f.strokeWeight=o.sw??1}f.cornerRadius=o.r??0;if(o.align)f.counterAxisAlignItems=o.align;if(o.just)f.primaryAxisAlignItems=o.just;return f}
function T(s,size=14,w='Regular',color=C.tx){const t=figma.createText();t.fontName={family:'Inter',style:w};t.characters=s;t.fontSize=size;t.fills=solid(color);return t}
function add(p,...cs){for(const c of cs)p.appendChild(c);return p}
function fillW(c){c.layoutSizingHorizontal='FILL';return c}
function fillH(c){c.layoutSizingVertical='FILL';return c}
function wrapT(p,t){p.appendChild(t);t.layoutSizingHorizontal='FILL';t.textAutoResize='HEIGHT';t.lineHeight={value:Math.round(t.fontSize*1.5),unit:'PIXELS'};return t}
function spacer(p){const s=figma.createFrame();s.name='spacer';s.fills=[];s.resize(1,1);p.appendChild(s);s.layoutSizingHorizontal='FILL';return s}
function btn(label,kind='sec',o={}){const sm=o.small;const f=box('Button/'+label,'HORIZONTAL',{gap:6,pad:sm?[6,10,6,10]:[9,14,9,14],r:8,fill:kind==='pri'?C.ac:kind==='warn'?C.wa:kind==='ghost'?null:C.s2,stroke:kind==='sec'?C.bd:null,align:'CENTER'});add(f,T(label,sm?12:13,'Semi Bold',kind==='pri'?'#ffffff':kind==='warn'?'#1a1205':kind==='ghost'?C.ac:C.tx));return f}
function dot(color,s=8){const d=figma.createEllipse();d.resize(s,s);d.fills=solid(color);return d}
function pill(label,color,bg,o={}){const f=box('Pill','HORIZONTAL',{gap:5,pad:[3,8,3,8],r:999,fill:bg,fo:o.fo??1,align:'CENTER'});if(o.dot)f.appendChild(dot(color,6));add(f,T(label,11,'Semi Bold',color));return f}
function check(color){const f=box('check','HORIZONTAL',{r:999,fill:color,fo:0.16,pad:[6,5,6,5],align:'CENTER'});const v=figma.createVector();v.vectorPaths=[{windingRule:'NONE',data:'M 1 5 L 4 8 L 10 2'}];v.strokes=solid(color);v.strokeWeight=1.8;v.strokeCap='ROUND';v.fills=[];add(f,v);return f}
function waitBadge(){const f=box('wait','HORIZONTAL',{r:999,fill:C.wa,fo:0.18,pad:[3,8,3,8]});add(f,T('!',11,'Bold',C.wt));return f}
function ring(){const e=figma.createEllipse();e.resize(18,18);e.fills=[];e.strokes=solid(C.bd);e.strokeWeight=1.5;return e}
function star(color,s=14,filled=true){const st=figma.createStar();st.pointCount=5;st.innerRadius=0.45;st.resize(s,s);st.fills=filled?solid(color):[];if(!filled){st.strokes=solid(color);st.strokeWeight=1.2}return st}
function stars(n,s=14){const r=box('stars','HORIZONTAL',{gap:3,align:'CENTER'});for(let i=0;i<5;i++)add(r,star(i<n?C.wt:C.mu,s,i<n));return r}
function chev(){const v=figma.createVector();v.vectorPaths=[{windingRule:'NONE',data:'M 0 0 L 4 4 L 8 0'}];v.strokes=solid(C.mu);v.strokeWeight=1.5;v.strokeCap='ROUND';v.fills=[];return v}
function sep(f,side='Bottom'){f.strokes=solid(C.bd);f.strokeTopWeight=0;f.strokeBottomWeight=0;f.strokeLeftWeight=0;f.strokeRightWeight=0;f['stroke'+side+'Weight']=1}
function label(t){const h=T(t.toUpperCase(),11,'Bold',C.mu);h.letterSpacing={value:6,unit:'PERCENT'};return h}
const KIND={FILE:C.dg,LINK:C.ac,FOLDER:C.ok,VPN:C.wt};
function srcChip(kind,text){const col=KIND[kind];const f=box('Source/'+text,'HORIZONTAL',{gap:6,pad:[5,10,5,6],r:999,fill:C.s2,stroke:C.bd,align:'CENTER'});const b=box('kind','HORIZONTAL',{r:4,fill:col,fo:0.16,pad:[2,5,2,5]});add(b,T(kind,9,'Bold',col));add(f,b,T(text,12,'Medium'));return f}
function seg(opts,active){const f=box('Toggle','HORIZONTAL',{gap:2,pad:3,r:8,fill:C.bg,stroke:C.bd});opts.forEach((o,i)=>{const it=box('Toggle/'+o,'HORIZONTAL',{pad:[5,12,5,12],r:6,fill:i===active?C.s2:null});add(it,T(o,12,'Semi Bold',i===active?C.tx:C.mu));add(f,it)});return f}
function card(name,parent){const c=box(name,'VERTICAL',{r:12,fill:C.s1,stroke:C.bd});add(parent,c);c.clipsContent=true;return c}
function toolbar(parent){const tb=box('Toolbar','HORIZONTAL',{gap:10,pad:[12,16,12,16],align:'CENTER'});add(parent,tb);fillW(tb);sep(tb);return tb}
function agentMsg(msgs,text){const b=box('Agent message','VERTICAL',{gap:10,pad:[10,12,10,12],r:12,fill:C.s2});add(msgs,b);fillW(b);wrapT(b,T(text,13,'Regular',C.tx));return b}
function userMsg(msgs,text){const row=box('User row','HORIZONTAL',{just:'MAX'});add(msgs,row);fillW(row);const b=box('User message','VERTICAL',{pad:[10,12,10,12],r:12,fill:C.ac,fo:0.22});add(row,b);b.resize(260,40);b.layoutSizingHorizontal='FIXED';wrapT(b,T(text,13,'Regular',C.tx));b.layoutSizingVertical='HUG';return b}
function proposal(parent,title,tag,lines,buttons){const pc=box('Proposal','VERTICAL',{gap:8,pad:12,r:10,fill:C.bg,stroke:C.bd});add(parent,pc);fillW(pc);const h=box('h','HORIZONTAL',{gap:8,align:'CENTER'});add(pc,h);add(h,T(title,12,'Semi Bold'),pill(tag,'#a9c1ff','#24324f'));for(const [t,c] of lines)wrapT(pc,T(t,12,'Medium',c));const b=box('b','HORIZONTAL',{gap:6,align:'CENTER'});add(pc,b);for(const [l,k] of buttons)add(b,btn(l,k,{small:true}));return pc}
function versionCol(parent,title,items,foot){const v=box('History','VERTICAL',{gap:2,pad:10,r:12,fill:C.s1,stroke:C.bd});add(parent,v);v.resize(240,100);v.layoutSizingHorizontal='FIXED';fillH(v);
  const h=box('h','HORIZONTAL',{pad:[6,8,8,8],align:'CENTER'});add(v,h);fillW(h);const ht=T(title,13,'Semi Bold');add(h,ht);ht.layoutGrow=1;add(h,T('Compare',12,'Semi Bold',C.ac));
  for(const [ver,meta,note,state] of items){const row=box('Version/'+ver,'VERTICAL',{gap:3,pad:[8,10,8,10],r:8,fill:state==='current'?C.s2:state==='draft'?C.wa:null,fo:state==='draft'?0.08:1});add(v,row);fillW(row);
    const a=box('a','HORIZONTAL',{gap:8,align:'CENTER'});add(row,a);add(a,T(ver,13,'Semi Bold',state==='draft'?C.wt:C.tx));if(state==='current')add(a,pill('Current','#a9c1ff','#24324f'));if(state==='draft')add(a,pill('Not saved',C.wt,C.wa,{fo:0.14}));
    add(row,T(meta,11,'Regular',C.mu));if(note)wrapT(row,T(note,12,'Regular',C.tx));}
  if(foot){const f=box('Lineage','VERTICAL',{pad:[12,8,4,8],gap:6});add(v,f);fillW(f);sep(f,'Top');add(f,label('Used by'));for(const l of foot)wrapT(f,T(l,12,'Regular',C.mu));}
  return v}
function restyleStep(s,sel){s.fills=solid(sel?'#17213a':C.s1);s.strokes=solid(sel?C.ac:C.bd);const n=s.children[0];n.fills=solid(sel?C.ac:C.s2);n.children[0].fills=solid(sel?'#ffffff':C.mu);const p=s.children[1].children[0].children[1];p.fills=solid(sel?'#24324f':C.s2);p.findOne(t=>t.type==='TEXT').fills=solid(sel?'#a9c1ff':C.mu)}
function setStep(s,ver,sub){s.children[1].children[0].children[1].findOne(t=>t.type==='TEXT').characters=ver;s.children[1].children[1].characters=sub}
async function makeScreen(name,x,y,stepIdx,ctxLabel){
  const base=await figma.getNodeByIdAsync('1:2');const F=base.clone();F.name=name;F.x=x;F.y=y;
  const steps=F.findOne(n=>n.name==='Workflow spine').children.filter(n=>n.name.startsWith('Step/'));
  steps.forEach((s,i)=>restyleStep(s,i===stepIdx));
  const ws=F.findOne(n=>n.name==='Workspace');for(const c of [...ws.children])c.remove();
  const msgs=F.findOne(n=>n.name==='Messages');for(const c of [...msgs.children])c.remove();
  F.findOne(n=>n.name==='Context').children[1].findOne(t=>t.type==='TEXT').characters=ctxLabel;
  if(stepIdx!==3){const b=F.findOne(n=>n.name==='Header').findOne(n=>n.name==='Button/Start run');b.fills=solid(C.s2);b.strokes=solid(C.bd);b.strokeWeight=1;b.children[0].fills=solid(C.tx)}
  return {F,ws,msgs,steps}}
const out={};
// ---------- Requirements step ----------
{const S=await makeScreen('Project detail — Requirements step',0,1124,0,'Requirements · editing');
setStep(S.steps[0],'v5 · edited','Unsaved changes · 5 sources');
const ed=card('Requirements editor',S.ws);fillW(ed);fillH(ed);
const tb=toolbar(ed);add(tb,T('Requirements',15,'Semi Bold'),pill('v5','#a9c1ff','#24324f'),pill('Unsaved changes',C.wt,C.wa,{fo:0.14,dot:true}));spacer(tb);
add(tb,btn('Attach','sec',{small:true}),btn('Discard','ghost',{small:true}),btn('Save as v6','pri',{small:true}));
const doc=box('Document','VERTICAL',{gap:20,pad:[22,28,22,28]});add(ed,doc);fillW(doc);fillH(doc);
const sec=t=>{const s=box('Section/'+t,'VERTICAL',{gap:8});add(doc,s);fillW(s);add(s,label(t));return s};
const sugg=(parent,text)=>{const f=box('Suggested edit','HORIZONTAL',{gap:10,pad:[8,12,8,12],r:8,fill:C.ok,fo:0.08,stroke:C.ok,so:0.35,align:'CENTER'});add(parent,f);fillW(f);const t=T(text,14,'Regular',C.tx);add(f,t);t.layoutSizingHorizontal='FILL';t.textAutoResize='HEIGHT';add(f,pill('Agent',C.ok,C.ok,{fo:0.16}),T('Accept',12,'Semi Bold',C.ac),T('Reject',12,'Semi Bold',C.mu));return f};
let s=sec('Goal');wrapT(s,T('Every Monday at 09:00, send the Finance team a one-page digest of last week’s sales, with two charts and a short note on what changed.',14));
s=sec('Sources');const ch=box('Sources','HORIZONTAL',{gap:8});add(s,ch);fillW(ch);ch.layoutWrap='WRAP';ch.counterAxisSpacing=8;
[['FILE','sales_nov.xlsx'],['LINK','CRM · Q4 pipeline'],['LINK','Finance KPI page (internal)'],['FOLDER','Folder bridge · /finance/reports'],['VPN','VPN · hq-intranet']].forEach(c=>add(ch,srcChip(c[0],c[1])));
s=sec('Audience');wrapT(s,T('The Finance distribution list (32 people). The email is sent from leo.lau@hangsengdev.com.',14));sugg(s,'Leave out addresses that bounced in the previous run.');
s=sec('Done when');
for(const b of ['Charts: revenue by region and top 10 products.','A person approves the email before it is sent.','A short summary is posted to #sales.']){const r=box('Bullet','HORIZONTAL',{gap:10});add(s,r);fillW(r);add(r,T('•',14,'Bold',C.mu));wrapT(r,T(b,14))}
sugg(s,'The PDF summary is at most 4 pages.');
const dz=box('Drop zone','HORIZONTAL',{gap:8,pad:[12,14,12,14],r:10,stroke:C.bd,align:'CENTER'});dz.dashPattern=[4,4];add(doc,dz);fillW(dz);
add(dz,T('Drop files here, or add',12,'Regular',C.mu),pill('+ File',C.tx,C.s2),pill('+ Link',C.tx,C.s2),pill('+ Folder bridge',C.tx,C.s2),pill('+ VPN reference',C.tx,C.s2));
const ft=box('Footer','HORIZONTAL',{gap:8,pad:[10,16,10,16],align:'CENTER',fill:C.s2,fo:0.5});add(ed,ft);fillW(ft);sep(ft,'Top');add(ft,dot(C.wa,6));wrapT(ft,T('Saving creates v6. Plan v3 was built from v5, so the Plan step will offer to update.',12,'Regular',C.mu));
versionCol(S.ws,'Versions',[['v6','Not saved yet','2 agent edits waiting','draft'],['v5','Yan · 2 h ago','Added CRM link and VPN reference','current'],['v4','Agent · Mon','Audience: Finance list'],['v3','Yan · 12 Nov','Added charts'],['v2','Yan · 10 Nov',''],['v1','Yan · 8 Nov','First draft']],['Plan v3 is built from v5.','Runs R6 and R7 used v5.']);
userMsg(S.msgs,'3 emails bounced last week and the PDF was too long. Can you fix the requirements?');
const m=agentMsg(S.msgs,'I suggested 2 edits. They are highlighted in green in the document:');
proposal(m,'Requirements','v5 → v6',[['+  Audience: leave out bounced addresses',C.ok],['+  Done when: PDF of at most 4 pages',C.ok]],[['Accept both','pri'],['Review in document','sec'],['Discard','ghost']]);
agentMsg(S.msgs,'After you save v6, I can update the plan to match.');
out.requirements=S.F.id}
// ---------- Plan step ----------
{const S=await makeScreen('Project detail — Plan step',1540,1124,1,'Plan v3');
setStep(S.steps[0],'v6','Saved just now · 5 sources');setStep(S.steps[1],'v3','Out of date · from Requirements v5');add(S.steps[1].children[1].children[0],dot(C.wa,8));
const col=box('Plan column','VERTICAL',{gap:12});add(S.ws,col);fillW(col);fillH(col);
const bn=box('Out-of-date banner','HORIZONTAL',{gap:12,pad:[12,16,12,16],r:10,fill:C.wa,fo:0.07,stroke:C.wa,so:0.4,align:'CENTER'});add(col,bn);fillW(bn);
add(bn,waitBadge());const bt=box('t','VERTICAL',{gap:3});add(bn,bt);fillW(bt);add(bt,T('Requirements changed after this plan was built',13,'Semi Bold',C.wt));wrapT(bt,T('Plan v3 is from Requirements v5. v6 adds 2 rules: leave out bounced addresses, and a PDF of at most 4 pages.',12,'Regular',C.mu));
add(bn,btn('See changes','sec',{small:true}),btn('Update plan','pri',{small:true}));
const pc=card('Plan',col);fillW(pc);fillH(pc);
const tb=toolbar(pc);add(tb,T('Plan',15,'Semi Bold'),pill('v3','#a9c1ff','#24324f'),T('Generated by agent · edited by Yan',12,'Regular',C.mu));spacer(tb);add(tb,seg(['Steps','Diff v2 → v3'],0),btn('Edit','sec',{small:true}),btn('Make cards','sec',{small:true}));
const steps=[['Pull last week’s sales from the CRM','Export deals closed last week, grouped by region.','Data analyst','Has CRM access over the hq-intranet VPN',[['LINK','CRM · Q4 pipeline'],['VPN','hq-intranet']]],
['Merge with the finance sheet','Match each deal to invoiced revenue.','Data analyst','Keeps the data in one profile',[['FILE','sales_nov.xlsx']]],
['Build the charts and PDF summary','Revenue by region and top 10 products.','Visualiser','Has the data-visualization skill',[]],
['Email the digest to the Finance list','Send from leo.lau@hangsengdev.com with the PDF attached.','Mailer','Only profile with a connected mailbox',[],1],
['Post a summary to #sales','Three lines and a link to the charts.','Messenger','Has the Slack connection',[]],
['Archive outputs to the Finance folder','Save the PDF, charts and email.','Archivist','Can write to the folder bridge',[['FOLDER','/finance/reports']]]];
steps.forEach((st,i)=>{const r=box('Plan step/'+(i+1),'HORIZONTAL',{gap:14,pad:[12,16,12,16]});add(pc,r);fillW(r);if(i>0)sep(r,'Top');
const n=box('n','HORIZONTAL',{r:999,fill:C.s2,pad:[4,9,4,9]});add(n,T(String(i+1),12,'Bold',C.mu));add(r,n);
const b=box('body','VERTICAL',{gap:6});add(r,b);fillW(b);const a=box('a','HORIZONTAL',{gap:8,align:'CENTER'});add(b,a);add(a,T(st[0],14,'Medium'));if(st[5])add(a,pill('Needs approval',C.wt,C.wa,{fo:0.14}));
add(b,T(st[1],12,'Regular',C.mu));const m=box('meta','HORIZONTAL',{gap:8,align:'CENTER'});add(b,m);add(m,pill(st[2],C.tx,C.s2));for(const [k,t] of st[4])add(m,srcChip(k,t));add(m,T('Why: '+st[3],11,'Regular',C.mu))});
versionCol(S.ws,'Versions',[['v3','Yan · yesterday · from Req v5','Reworded step 4','current'],['v2','Agent · Mon · from Req v4','Added the archive step'],['v1','Agent · 10 Nov · from Req v2','Generated']],['Runs R6 and R7 used v3.','Runs R3–R5 used v1–v2.']);
const m=agentMsg(S.msgs,'Requirements v6 changed 2 rules. This is how the plan would change:');
proposal(m,'Plan','v3 → v4',[['~  Step 3: PDF of at most 4 pages',C.wt],['~  Step 4: leave out bounced addresses',C.wt],['   Steps 1, 2, 5 and 6 unchanged',C.mu],['   Built from Requirements v6',C.mu]],[['Save as v4','pri'],['View diff','sec'],['Discard','ghost']]);
userMsg(S.msgs,'Why is the Mailer doing step 4?');
agentMsg(S.msgs,'It’s the only profile in this project with a connected mailbox (leo.lau@hangsengdev.com). The approval before sending stays on.');
out.plan=S.F.id}
return out;

// ===== part 2: helpers (repeat part 1's helpers) + Cards Kanban + Cards Graph + Compare =====
// ---------- Cards step: Kanban ----------
function tile(parent,num,title,profile,io,tag,o={}){const t=box('Card/'+num,'VERTICAL',{gap:6,pad:10,r:8,fill:C.s2,stroke:o.sel?C.ac:C.bd,sw:o.sel?1.5:1});add(parent,t);fillW(t);
const a=box('a','HORIZONTAL',{gap:6,align:'CENTER'});add(t,a);add(a,T(String(num),11,'Bold',C.mu));if(o.approve)add(a,pill('Approval',C.wt,C.wa,{fo:0.14}));
wrapT(t,T(title,13,'Medium'));wrapT(t,T(io,11,'Regular',C.mu));const r=box('r','HORIZONTAL',{gap:6,align:'CENTER'});add(t,r);add(r,pill(profile,C.tx,C.bg),pill(tag,tag==='Edited'?'#a9c1ff':C.mu,tag==='Edited'?'#24324f':C.bg));return t}
{const S=await makeScreen('Project detail — Cards step (Kanban)',0,2248,2,'Cards › Card 4');
setStep(S.steps[2],'6','Kanban · from Plan v3');
const bd=card('Board',S.ws);fillW(bd);fillH(bd);
const tb=toolbar(bd);add(tb,T('Cards',15,'Semi Bold'),seg(['Kanban','Graph'],0),T('6 cards from Plan v3 · status from run R7',12,'Regular',C.mu));spacer(tb);add(tb,btn('Regenerate from plan','sec',{small:true}),btn('+ Card','sec',{small:true}));
const cols=box('Columns','HORIZONTAL',{gap:10,pad:12});add(bd,cols);fillW(cols);fillH(cols);
const mk=(name,color,n)=>{const c=box('Column/'+name,'VERTICAL',{gap:8,pad:8,r:10,fill:C.bg});add(cols,c);fillW(c);fillH(c);const h=box('h','HORIZONTAL',{gap:8,align:'CENTER',pad:[4,4,4,4]});add(c,h);add(h,dot(color),T(name,12,'Semi Bold'),T(String(n),12,'Regular',C.mu));return c};
let c=mk('Ready',C.mu,2);tile(c,5,'Post a summary to #sales','Messenger','In: PDF summary · Out: Slack post','Auto');tile(c,6,'Archive outputs to the Finance folder','Archivist','Out: /finance/reports','Auto');
c=mk('Running',C.ac,0);const e=box('empty','VERTICAL',{pad:[16,8,16,8],align:'CENTER'});add(c,e);fillW(e);add(e,T('Nothing running',12,'Regular',C.mu));
c=mk('Needs you',C.wa,1);tile(c,4,'Email the digest to the Finance list','Mailer','In: PDF, charts · Out: email','Edited',{sel:1,approve:1});
c=mk('Done',C.ok,3);tile(c,1,'Pull last week’s sales from the CRM','Data analyst','Out: sales.csv','Auto');tile(c,2,'Merge with the finance sheet','Data analyst','In: sales_nov.xlsx','Auto');tile(c,3,'Build the charts and PDF summary','Visualiser','Out: PDF, charts.html','Auto');
const dp=card('Card detail',S.ws);dp.resize(300,100);dp.layoutSizingHorizontal='FIXED';fillH(dp);
const dh=box('h','VERTICAL',{gap:8,pad:16});add(dp,dh);fillW(dh);sep(dh);const k=box('k','HORIZONTAL',{align:'CENTER'});add(dh,k);fillW(k);const kt=T('Card 4 · Plan v3 step 4',11,'Regular',C.mu);add(k,kt);kt.layoutGrow=1;add(k,T('✕',12,'Regular',C.mu));
wrapT(dh,T('Email the digest to the Finance list',15,'Semi Bold'));const pr=box('p','HORIZONTAL',{gap:6});add(dh,pr);add(pr,pill('Needs approval',C.wt,C.wa,{fo:0.14}),pill('Edited by Yan','#a9c1ff','#24324f'));
const db=box('body','VERTICAL',{gap:16,pad:16});add(dp,db);fillW(db);fillH(db);
const ds=t=>{const s=box('Field/'+t,'VERTICAL',{gap:8});add(db,s);fillW(s);add(s,label(t));return s};
let s=ds('Instructions');wrapT(s,T('Send “Weekly sales digest — <week>” from leo.lau@hangsengdev.com to the Finance list. Attach the PDF. Link the two charts in the body.',13));
s=ds('Inputs');const ic=box('chips','HORIZONTAL',{gap:6});add(s,ic);fillW(ic);ic.layoutWrap='WRAP';ic.counterAxisSpacing=6;add(ic,srcChip('FILE','sales-summary.pdf'),srcChip('LINK','charts.html'),srcChip('LINK','Finance list'));
s=ds('Output');add(s,srcChip('FILE','email-draft.md'));
s=ds('Profile');const pf=box('r','HORIZONTAL',{gap:8,align:'CENTER'});add(s,pf);add(pf,pill('Mailer',C.tx,C.s2),T('Only profile with a mailbox',11,'Regular',C.mu));
s=ds('Approval');const ap=box('r','HORIZONTAL',{gap:10,align:'CENTER'});add(s,ap);fillW(ap);const at=T('Ask me before sending',13);add(ap,at);at.layoutGrow=1;const tg=box('Switch','HORIZONTAL',{r:999,fill:C.ac,pad:2,just:'MAX'});tg.primaryAxisSizingMode='FIXED';tg.resize(32,18);add(tg,dot('#ffffff',14));add(ap,tg);
const df=box('Footer','HORIZONTAL',{gap:8,pad:[12,16,12,16],align:'CENTER'});add(dp,df);fillW(df);sep(df,'Top');add(df,btn('Edit','sec',{small:true}),btn('Ask agent','ghost',{small:true}));
userMsg(S.msgs,'Also copy Jensen on the digest email.');
const m=agentMsg(S.msgs,'I’ll update card 4. Only this card changes; Plan v3 stays as it is.');
proposal(m,'Card 4','1 change',[['+  CC: jensen.ip@hangsengdev.com',C.ok],['   Approval before sending stays on',C.mu]],[['Apply','pri'],['View diff','sec'],['Discard','ghost']]);
out.kanban=S.F.id}
// ---------- Cards step: Graph ----------
{const S=await makeScreen('Project detail — Cards step (Graph)',1540,2248,2,'Cards · Graph');
setStep(S.steps[2],'6','Graph · from Plan v3');
const bd=card('Board',S.ws);fillW(bd);fillH(bd);
const tb=toolbar(bd);add(tb,T('Cards',15,'Semi Bold'),seg(['Kanban','Graph'],1),T('6 cards · 6 links · drag between cards to link them',12,'Regular',C.mu));spacer(tb);add(tb,btn('Regenerate from plan','sec',{small:true}),btn('+ Card','sec',{small:true}));
const cv=figma.createFrame();cv.name='Graph canvas';cv.fills=solid(C.bg);add(bd,cv);fillW(cv);fillH(cv);cv.clipsContent=true;
const W=cv.width,H=cv.height;
const NW=168,cx=[40,240,440,640,840].map(v=>Math.round(v*(W-NW-40)/840)),my=Math.round(H/2)-60;
const nodes={1:[cx[0],my],2:[cx[1],my],3:[cx[2],my],4:[cx[3],my],5:[cx[4],my-150],6:[cx[4],my+170]};
const NH=118;
const edges=[[1,2,1],[2,3,1],[3,4,1],[4,5,0],[4,6,0],[3,6,0]];
for(const [a,b,done] of edges){const [ax,ay]=nodes[a],[bx,by]=nodes[b];const x1=ax+NW,y1=ay+NH/2,x2=bx-8,y2=by+NH/2;const v=figma.createVector();v.name=`Link ${a}→${b}`;cv.appendChild(v);
v.vectorPaths=[{windingRule:'NONE',data:`M ${x1} ${y1} C ${x1+60} ${y1} ${x2-60} ${y2} ${x2} ${y2}`}];v.x=Math.min(x1,x2);v.y=Math.min(y1,y2);v.strokes=solid(done?C.ok:C.mu,done?0.7:0.6);v.strokeWeight=1.5;v.fills=[];if(!done)v.dashPattern=[5,4];
const h=figma.createVector();h.name='arrow';cv.appendChild(h);h.vectorPaths=[{windingRule:'NONE',data:'M 0 0 L 7 5 L 0 10'}];h.x=x2;h.y=y2-5;h.strokes=solid(done?C.ok:C.mu);h.strokeWeight=1.5;h.fills=[];}
const info={1:['Pull last week’s sales from the CRM','Data analyst','done'],2:['Merge with the finance sheet','Data analyst','done'],3:['Build the charts and PDF summary','Visualiser','done'],4:['Email the digest to the Finance list','Mailer','wait'],5:['Post a summary to #sales','Messenger','todo'],6:['Archive outputs to the Finance folder','Archivist','todo']};
for(const k of Object.keys(info)){const [t,p,st]=info[k];const n=box('Node/'+k,'VERTICAL',{gap:8,pad:12,r:10,fill:C.s1,stroke:st==='wait'?C.wa:C.bd,sw:st==='wait'?1.5:1});cv.appendChild(n);n.counterAxisSizingMode='FIXED';n.resize(NW,NH);n.primaryAxisSizingMode='FIXED';n.x=nodes[k][0];n.y=nodes[k][1];
const a=box('a','HORIZONTAL',{gap:8,align:'CENTER'});add(n,a);add(a,st==='done'?check(C.ok):st==='wait'?waitBadge():ring(),T(k+' · '+(st==='done'?'Done':st==='wait'?'Needs you':'Ready'),11,'Semi Bold',st==='done'?C.ok:st==='wait'?C.wt:C.mu));
wrapT(n,T(t,13,'Medium'));add(n,pill(p,C.tx,C.s2))}
const lg=box('Legend','HORIZONTAL',{gap:14,pad:[8,12,8,12],r:8,fill:C.s1,stroke:C.bd,align:'CENTER'});cv.appendChild(lg);
for(const [c,l] of [[C.ok,'Done'],[C.ac,'Running'],[C.wa,'Needs you'],[C.mu,'Ready']]){const i=box('i','HORIZONTAL',{gap:6,align:'CENTER'});add(i,dot(c),T(l,11,'Medium',C.mu));add(lg,i)}
lg.x=16;lg.y=H-lg.height-16;
const zm=box('Zoom','HORIZONTAL',{gap:4,pad:4,r:8,fill:C.s1,stroke:C.bd,align:'CENTER'});cv.appendChild(zm);for(const l of ['−','100%','+','Fit']){const z=box('z','HORIZONTAL',{pad:[4,8,4,8],r:6});add(z,T(l,12,'Medium',C.mu));add(zm,z)}zm.x=W-zm.width-16;zm.y=H-zm.height-16;
const m=agentMsg(S.msgs,'Card 6 waits for the email, but archiving only needs the PDF and charts. If it follows card 3 instead, runs finish about 2 minutes sooner.');
proposal(m,'Cards','1 link',[['−  Card 4 → Card 6',C.dg],['   Card 3 → Card 6 stays',C.mu]],[['Apply','pri'],['Discard','ghost']]);
userMsg(S.msgs,'Does that change the plan?');
agentMsg(S.msgs,'Only the order of cards. Plan v3 stays the same, and the next run uses the new order.');
out.graph=S.F.id}
// ---------- Runs step: Compare ----------
{const S=await makeScreen('Project detail — Compare runs',0,3372,3,'Runs › R6 ↔ R7');
setStep(S.steps[3],'7','Comparing R6 and R7');
const ss=S.F.findOne(n=>n.name==='Status sentence');ss.children[1].characters='Last run R7 finished 10:17 ·';ss.children[2].characters='graded 5 ★';
const cc=card('Compare',S.ws);fillW(cc);fillH(cc);
const tb=toolbar(cc);add(tb,btn('‹ Runs','ghost',{small:true}),T('Compare R6 and R7',15,'Semi Bold'));spacer(tb);add(tb,btn('Swap','sec',{small:true}),btn('Open R7','sec',{small:true}));
const row=(lab,a,b,diff,o={})=>{const r=box('Row/'+lab,'HORIZONTAL',{gap:12,pad:[o.pad??8,16,o.pad??8,16],align:o.top?'MIN':'CENTER'});add(cc,r);fillW(r);sep(r);
const l=box('label','HORIZONTAL',{});add(r,l);l.resize(170,10);l.layoutSizingHorizontal='FIXED';add(l,typeof lab==='string'?T(lab,12,'Medium',C.mu):lab);
for(const [i,v] of [[0,a],[1,b]]){const cell=box('cell','HORIZONTAL',{gap:8,pad:[6,10,6,10],r:6,align:'CENTER',fill:diff&&i===1?C.ac:null,fo:0.1});add(r,cell);fillW(cell);add(cell,typeof v==='string'?T(v,13,'Medium'):v)}return r};
const hd=(n,b)=>{const f=box('h','HORIZONTAL',{gap:8,align:'CENTER'});add(f,T(n,15,'Semi Bold'),pill('Done',C.ok,C.ok,{fo:0.14}),T(b,12,'Regular',C.mu));return f};
row(T('Changed values are highlighted',11,'Regular',C.mu),hd('R6','Nov week 3 · 13 Nov'),hd('R7','Nov week 4 · 20 Nov'),0,{pad:10});
row('Plan','v3','v3');row('Requirements','v5','v5');row('Iteration batch','Nov week 3 · 3 inputs','Nov week 4 · 3 inputs (1 new)',1);
row('Duration','12 min','15 min',1);row('Cost','$0.58','$0.62',1);row('Approvals','1 · approved by Yan','1 · approved by Yan');row('Emails sent','32 · 3 bounced','29 · none bounced',1);
row('Your grade',stars(4),stars(5),1);row('Agent self-score','4 / 5','4 / 5');
const ol=n=>{const f=box('outs','VERTICAL',{gap:6});for(const [k,t] of n)add(f,srcChip(k,t));return f};
row('Outputs',ol([['FILE','sales-summary.pdf · 3 pages'],['LINK','charts.html'],['FILE','email-draft.md']]),ol([['FILE','sales-summary.pdf · 4 pages'],['LINK','charts.html'],['FILE','email-draft.md']]),1,{top:1});
const sm=box('What changed','VERTICAL',{gap:8,pad:[14,16,14,16]});add(cc,sm);fillW(sm);const smh=box('h','HORIZONTAL',{gap:8,align:'CENTER'});add(sm,smh);add(smh,T('What changed',13,'Semi Bold'),pill('Agent summary','#a9c1ff','#24324f'));spacer(smh);add(smh,T('Open outputs side by side',12,'Semi Bold',C.ac));
for(const b of ['R7 left out the 3 addresses that bounced in R6.','The PDF grew from 3 to 4 pages because of a new table by region.','The charts are the same; the data is one week newer.']){const r=box('Bullet','HORIZONTAL',{gap:10});add(sm,r);fillW(r);add(r,T('•',13,'Bold',C.mu));wrapT(r,T(b,13))}
agentMsg(S.msgs,'R7 scored higher mainly because no emails bounced. It took 3 minutes longer, all of it spent on the extra PDF page.');
userMsg(S.msgs,'Keep the bounce rule for future runs.');
const m=agentMsg(S.msgs,'It’s already in Requirements v6 and the proposed Plan v4. Save Plan v4 to use it in the next run.');
add(m,btn('Open Plan v4 proposal','sec',{small:true}));
out.compare=S.F.id}
return out;

// ===== part 3: post-fix (text that overflowed in the first render) =====
// Plan spine sub-text -> 'Out of date · from Req v5'; Kanban/Graph 'Regenerate from plan' -> 'Regenerate';
// Kanban toolbar text -> 'From Plan v3 · status from R7'; Compare row 'label' frames -> layoutSizingVertical='HUG'.
