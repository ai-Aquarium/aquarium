// Figma Plugin API script that drew the "Agent co-author panel — states" board (node 18:2) in
// https://www.figma.com/design/2ulo0wiREINRTTsynkpkgl. Self-contained: shared helpers first, then the board.
// Run through the Figma MCP `use_figma` tool.
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

// ---------- Agent co-author panel: states board ----------
const G=(a,b)=>[{type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{...hex(a),a:1}},{position:1,color:{...hex(b),a:1}}]}];
const BW=2000,BH=1230,PY=170;
const B=figma.createFrame();B.name='Agent co-author panel — states';B.resize(BW,BH);B.x=0;B.y=4520;B.fills=solid('#07080c');B.cornerRadius=16;
const place=(n,x,y)=>{B.appendChild(n);n.x=x;n.y=y;return n};
place(T('Agent co-author panel',28,'Semi Bold'),40,36);
place(T('One panel on every step. It knows the step you are on, shows its work, and only changes things after you accept.',14,'Regular',C.mu),40,80);
function caption(x,title,sub){place(T(title,18,'Semi Bold'),x,PY-62);place(T(sub,12,'Regular',C.mu),x,PY-34)}
function avatar(s){const e=figma.createEllipse();e.resize(s,s);e.fills=G('#8b5cf6',C.ac);return e}
function spin(s=16){const e=figma.createEllipse();e.resize(s,s);e.arcData={startingAngle:0,endingAngle:Math.PI*1.5,innerRadius:0.75};e.fills=solid(C.ac);return e}
function panel(name,x,ctx,sees,profile='Planner'){const P=box('Agent panel — '+name,'VERTICAL',{fill:C.s1,stroke:C.bd,r:12});place(P,x,PY);P.resize(380,1024);P.primaryAxisSizingMode='FIXED';P.counterAxisSizingMode='FIXED';P.clipsContent=true;
 const ah=box('Agent header','HORIZONTAL',{gap:10,pad:[14,16,14,16],align:'CENTER'});add(P,ah);fillW(ah);sep(ah);add(ah,avatar(24),T('Agent',14,'Semi Bold'),pill('Co-author','#a9c1ff','#24324f'));spacer(ah);
 const pk=box('Profile picker','HORIZONTAL',{gap:6,pad:[5,8,5,8],r:6,stroke:C.bd,align:'CENTER'});add(pk,T(profile,12,'Medium'),chev());add(ah,pk,T('»',16,'Medium',C.mu));
 const cx=box('Context','HORIZONTAL',{gap:6,pad:[10,16,10,16],align:'CENTER'});add(P,cx);fillW(cx);sep(cx);add(cx,T('Working on',11,'Regular',C.mu),pill(ctx,C.tx,C.s2));spacer(cx);add(cx,T(sees,11,'Medium',C.ac));
 const msgs=box('Messages','VERTICAL',{gap:14,pad:16});add(P,msgs);fillW(msgs);fillH(msgs);return {P,msgs}}
function composer(P,o={}){const cp=box('Composer wrap','VERTICAL',{pad:[12,16,12,16],gap:8});add(P,cp);fillW(cp);sep(cp,'Top');
 const comp=box('Composer','VERTICAL',{gap:12,pad:12,r:12,fill:C.bg,stroke:o.focus?C.ac:C.bd});add(cp,comp);fillW(comp);
 if(o.chips){const r=box('Attached','HORIZONTAL',{gap:6});add(comp,r);for(const [k,t] of o.chips)add(r,srcChip(k,t))}
 wrapT(comp,T(o.text||'Ask the agent, or describe a change…',13,'Regular',o.text?C.tx:C.mu));
 const cr=box('Actions','HORIZONTAL',{gap:8,align:'CENTER'});add(comp,cr);fillW(cr);add(cr,pill('+ Attach',o.menu?'#ffffff':C.mu,o.menu?C.ac:C.s2),pill('@ Mention',C.mu,C.s2));spacer(cr);
 const sd=box(o.stop?'Stop':'Send','HORIZONTAL',{r:8,fill:o.stop?C.s2:C.ac,stroke:o.stop?C.bd:null,pad:[6,10,6,10],gap:6,align:'CENTER'});if(o.stop){const q=figma.createRectangle();q.resize(8,8);q.cornerRadius=2;q.fills=solid(C.tx);add(sd,q)}add(sd,T(o.stop?'Stop':'Send',12,'Semi Bold',o.stop?C.tx:'#ffffff'));add(cr,sd);
 add(cp,T(o.hint||'Enter to send · Shift+Enter for a new line',11,'Regular',C.mu));return cp}
function row(parent,name,o={}){const r=box(name,'HORIZONTAL',{gap:o.gap??8,align:'CENTER',pad:o.pad??0});add(parent,r);fillW(r);return r}
// A — empty, step-aware
{caption(40,'1 · Start','Suggestions match the step. It says what it can see.');
const {P,msgs}=panel('Start',40,'Requirements v5','Sees 6 items');
const e=box('Empty state','VERTICAL',{gap:10,pad:[28,8,8,8],align:'CENTER'});add(msgs,e);fillW(e);add(e,avatar(44),T('Co-write the requirements',16,'Semi Bold'));
const et=T('I can read Requirements v5 and its 5 sources. I suggest edits; you accept them.',13,'Regular',C.mu);wrapT(e,et);et.textAlignHorizontal='CENTER';
add(msgs,label('Try'));
for(const s of ['Turn my notes into requirements','Find gaps and contradictions','Summarize the 5 sources','Write the “Done when” checklist']){const r=box('Suggestion','HORIZONTAL',{gap:8,pad:[10,12,10,12],r:10,fill:C.s2,stroke:C.bd,align:'CENTER'});add(msgs,r);fillW(r);add(r,T(s,13,'Medium'));spacer(r);add(r,T('→',13,'Medium',C.mu))}
const sw=box('Sees','VERTICAL',{gap:8,pad:12,r:10,stroke:C.bd});add(msgs,sw);fillW(sw);add(sw,label('What I can see'));
for(const [k,t] of [[C.ac,'Requirements v5 (editing)'],[C.ok,'5 sources: 1 file, 2 links, 1 folder, 1 VPN'],[C.mu,'Plan v3 · Runs R1–R7 (read only)']]){const r=row(sw,'item');add(r,dot(k,6));wrapT(r,T(t,12,'Regular',C.tx))}
composer(P);}
// B — working
{caption(460,'2 · Working','Shows each step live. Stop any time; new messages wait.');
const {P,msgs}=panel('Working',460,'Plan v3','Sees 4 items');
userMsg(msgs,'Update the plan from Requirements v6.');
const w=box('Working card','VERTICAL',{gap:10,pad:12,r:12,fill:C.s2});add(msgs,w);fillW(w);
const h=row(w,'h',{gap:10});add(h,spin(16));wrapT(h,T('Building Plan v4 from Requirements v6',13,'Semi Bold'));
for(const [st,t] of [['done','Read Requirements v6 · 2 changes'],['done','Compared with Plan v3'],['now','Rewriting steps 3 and 4'],['todo','Checking each profile can still do its step']]){const r=row(w,'Work step',{gap:10,pad:[2,0,2,2]});add(r,st==='done'?check(C.ok):st==='now'?spin(14):ring());add(r,T(t,12,st==='todo'?'Regular':'Medium',st==='todo'?C.mu:C.tx))}
const f=row(w,'f');add(f,T('Planner · 42 s',11,'Regular',C.mu));spacer(f);add(f,btn('Stop','sec',{small:true}));
userMsg(msgs,'Also keep step 5 to three lines.');
const q=row(msgs,'Queued',{gap:6});spacer(q);add(q,T('Waiting · read when the plan is ready',11,'Regular',C.mu));
composer(P,{stop:1,hint:'The agent is working · new messages wait their turn'});}
// C — proposal
{caption(880,'3 · Proposal','Before/after diff. Nothing is saved until you choose.');
const {P,msgs}=panel('Proposal',880,'Plan v3','Sees 4 items');
const done=box('Resolved','HORIZONTAL',{gap:10,pad:[8,12,8,12],r:8,stroke:C.bd,align:'CENTER'});add(msgs,done);fillW(done);add(done,check(C.ok),T('Saved as Requirements v6',12,'Medium'));spacer(done);add(done,T('Undo',12,'Semi Bold',C.ac));
const dis=box('Resolved','HORIZONTAL',{gap:10,pad:[8,12,8,12],r:8,stroke:C.bd,align:'CENTER'});add(msgs,dis);fillW(dis);add(dis,ring(),T('Discarded: rename step 2',12,'Regular',C.mu));spacer(dis);add(dis,T('Restore',12,'Semi Bold',C.ac));
const m=agentMsg(msgs,'Plan v4 is ready. 2 steps change. Nothing is saved until you choose.');
const pc=box('Proposal','VERTICAL',{gap:10,pad:12,r:10,fill:C.bg,stroke:C.ac,so:0.5});add(m,pc);fillW(pc);
const ph=row(pc,'h');add(ph,T('Plan',12,'Semi Bold'),pill('v3 → v4','#a9c1ff','#24324f'));spacer(ph);add(ph,T('from Requirements v6',11,'Regular',C.mu));
const diff=(title,a,b)=>{const d=box('Change','VERTICAL',{gap:4});add(pc,d);fillW(d);add(d,T(title,12,'Semi Bold'));for(const [s,c] of [[a,C.dg],[b,C.ok]]){const l=box('line','HORIZONTAL',{pad:[4,8,4,8],r:4,fill:c,fo:0.09});add(d,l);fillW(l);const t=T(s,12,'Regular',c);wrapT(l,t);if(c===C.dg)t.textDecoration='STRIKETHROUGH'}};
diff('Step 3 · Build the charts and PDF','Revenue by region and top 10 products.','Same charts; the PDF is at most 4 pages.');
diff('Step 4 · Email the digest','Send to the Finance list.','Send to the Finance list, leaving out bounced addresses.');
const af=row(pc,'Affects',{gap:6});add(af,T('Affects',11,'Regular',C.mu),pill('Card 3',C.tx,C.s2),pill('Card 4',C.tx,C.s2),T('· 4 steps unchanged',11,'Regular',C.mu));
const bs=row(pc,'b',{gap:6});add(bs,btn('Save as v4','pri',{small:true}),btn('Edit first','sec',{small:true}),btn('Discard','ghost',{small:true}));
userMsg(msgs,'Why change step 3?');
agentMsg(msgs,'Requirements v6 says the PDF is at most 4 pages. R7’s PDF was already 4 pages, so the limit is close.');
composer(P);}
// D — step change, catch-up, inline action, attach menu
{caption(1300,'4 · Follows you','Moves with you to the new step; actions work inline.');
const {P,msgs}=panel('Follows you',1300,'Runs › R7','Sees 5 items','Runner');
const dv=row(msgs,'Step divider',{gap:8});const l1=figma.createRectangle();l1.resize(10,1);l1.fills=solid(C.bd);add(dv,l1);l1.layoutGrow=1;add(dv,T('You moved to Runs › R7',11,'Medium',C.mu));const l2=figma.createRectangle();l2.resize(10,1);l2.fills=solid(C.bd);add(dv,l2);l2.layoutGrow=1;
const un=row(msgs,'Unread',{});un.primaryAxisAlignItems='CENTER';add(un,pill('2 new while you were away',C.ac,C.ac,{fo:0.14,dot:true}));
const a=agentMsg(msgs,'R7 is waiting for you: it wants to email 32 people on the Finance list.');const ab=row(a,'Inline actions',{gap:6});add(ab,btn('Approve','pri',{small:true}),btn('Reject','sec',{small:true}),btn('Open in run','ghost',{small:true}));
const o=agentMsg(msgs,'The PDF summary is ready (4 pages).');add(o,srcChip('FILE','sales-summary.pdf'));
const cp=composer(P,{focus:1,menu:1,chips:[['FILE','sales-summary.pdf']],text:'Compare this with R6’s PDF',hint:'@ adds a project item · + Attach adds files, links, folders or VPN'});
const mn=box('Attach menu','VERTICAL',{gap:2,pad:6,r:10,fill:C.s2,stroke:C.bd});P.appendChild(mn);mn.layoutPositioning='ABSOLUTE';mn.resize(250,10);mn.primaryAxisSizingMode='AUTO';
mn.effects=[{type:'DROP_SHADOW',color:{r:0,g:0,b:0,a:0.5},offset:{x:0,y:10},radius:28,spread:0,visible:true,blendMode:'NORMAL'}];
const mi=(k,t,hl)=>{const r=box('Item/'+t,'HORIZONTAL',{gap:10,pad:[8,10,8,10],r:6,fill:hl?C.bd:null,align:'CENTER'});add(mn,r);fillW(r);if(k){const b=box('kind','HORIZONTAL',{r:4,fill:KIND[k],fo:0.16,pad:[2,5,2,5]});add(b,T(k,9,'Bold',KIND[k]));add(r,b)}add(r,T(t,13,'Medium'))};
mi('FILE','File from your computer',1);mi('LINK','Link (internal or external)');mi('FOLDER','Folder bridge');mi('VPN','VPN reference');
const sp=box('sep','HORIZONTAL',{pad:[6,10,4,10]});add(mn,sp);fillW(sp);add(sp,label('From this project'));
for(const t of ['Requirements version','Plan version','Card','Run output'])mi(null,t);
mn.x=16;mn.y=cp.y+12-mn.height-8;}
// E — collapsed
{caption(1720,'5 · Collapsed','A 56 px rail. The badge counts what needs you.');
const R=box('Agent rail (collapsed)','VERTICAL',{gap:14,pad:[14,0,14,0],fill:C.s1,stroke:C.bd,r:12,align:'CENTER'});place(R,1720,PY);R.resize(56,1024);R.primaryAxisSizingMode='FIXED';R.counterAxisSizingMode='FIXED';
add(R,T('«',16,'Medium',C.mu));const av=box('Avatar + badge','HORIZONTAL',{});add(R,av);av.clipsContent=false;add(av,avatar(30));const bd=box('Badge','HORIZONTAL',{r:999,fill:C.wa,pad:[1,5,1,5]});av.appendChild(bd);bd.layoutPositioning='ABSOLUTE';add(bd,T('2',10,'Bold','#1a1205'));bd.x=18;bd.y=-4;
const tip=box('Tooltip','VERTICAL',{gap:4,pad:[10,12,10,12],r:8,fill:C.s2,stroke:C.bd});place(tip,1788,PY+40);add(tip,T('Agent',12,'Semi Bold'),T('Plan v4 proposal waiting',12,'Regular',C.wt),T('R7 approval waiting',12,'Regular',C.wt),T('Click or press  /  to open',11,'Regular',C.mu));
tip.effects=[{type:'DROP_SHADOW',color:{r:0,g:0,b:0,a:0.5},offset:{x:0,y:8},radius:24,spread:0,visible:true,blendMode:'NORMAL'}];}
out.board=B.id;
return out;
