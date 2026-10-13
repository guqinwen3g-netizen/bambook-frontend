const IC = window.__ICONS, IMG = window.__IMG, MARK = window.__MARK;
const ic = (n, c = '') => `<svg class="i ${c}" viewBox="0 0 24 24" aria-hidden="true">${IC[n] || ''}</svg>`;
const mark = (c = 'mark') => `<svg class="${c}" viewBox="0 0 200 200" fill="currentColor" aria-hidden="true">${MARK}</svg>`;
const esc = s => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));

/* ── Data (based on project demo records) ── */
const STAGES = ['需求与计划','工厂与实物','QC 评审','需求方确认','成果留档'];
const DEVS = [
  {id:'DEV-G-2026-031',name:'双面羊毛城市大衣',style:'CC-AW27-COAT-014',owner:'顾言',due:'10/16',dueRel:'4 天后',stage:3,state:'待需求方确认',tone:'blue',ver:'R2-A-2',fac:2,img:'coat',factory:'江南成衣',sample:'SP-G-2026-0446',fabric:'双面羊毛 · 浅石色',goal:'开发轻量双面羊毛大衣，保留自然肩线；确认领型、手感和袖笼活动量。'},
  {id:'DEV-G-2026-021',name:'炭灰细格轻结构 Blazer',style:'CC-AW27-CHECK-003',owner:'顾言',due:'10/14',dueRel:'2 天后',stage:2,state:'待新样复验',tone:'bad',ver:'R2-A-2',fac:1,img:'blazer',factory:'江南成衣',sample:'SP-G-2026-0431',fabric:'炭灰细格毛混纺',goal:'按照准确版本 QC 结论修正袖长，返样复验。'},
  {id:'DEV-G-2026-030',name:'雾蓝精纺羊毛西装',style:'CC-AW27-SUIT-006',owner:'顾言',due:'10/18',dueRel:'6 天后',stage:2,state:'QC 待评审',tone:'warn',ver:'R1-A-2',fac:2,img:'suit',factory:'远山服装',sample:'SP-G-2026-0439',fabric:'240g/m² 雾蓝精纺羊毛',goal:'核对 240g/m² 精纺羊毛西装的首样尺寸和袖笼活动量。'},
  {id:'DEV-G-2026-032',name:'轻结构羊毛 Blazer',style:'CC-AW27-BLZ-008',owner:'沈禾',due:'10/20',dueRel:'8 天后',stage:1,state:'工厂制作中',tone:'',ver:'R1-A-1',fac:2,img:'blazer',factory:'远山服装',sample:'—',fabric:'羊毛平纹',goal:'减少肩部结构重量，完成常规码首样并核实面料挺括度。'},
  {id:'DEV-G-2026-029',name:'修身羊毛西装套装',style:'CC-AW27-SUIT-102',owner:'沈禾',due:'10/22',dueRel:'10 天后',stage:1,state:'实物已返样',tone:'ok',ver:'R2-B-1',fac:1,img:'suit',factory:'远山服装',sample:'SP-G-2026-0442',fabric:'精纺羊毛',goal:'复核改版后腰围和袖长，确认套装比例。'},
  {id:'DEV-G-2026-025',name:'女式短款双排扣大衣',style:'CC-AW27-COAT-019',owner:'沈禾',due:'10/25',dueRel:'13 天后',stage:0,state:'开发计划',tone:'',ver:'—',fac:0,img:'clay',factory:'待定',sample:'—',fabric:'待寻样',goal:'确认廓形、面料来源和目标价格。'},
];
const FABRICS = [
  {id:'SR-F-2026-018',name:'240g/m² 雾蓝精纺羊毛',owner:'沈禾',due:'10/15',state:'寻样中',tone:'warn',sub:'2 家工厂 · 3 个候选'},
  {id:'SR-F-2026-016',name:'双面羊毛 · 浅石色',owner:'顾言',due:'10/14',state:'待发起人确认',tone:'blue',sub:'1 家工厂 · 2 个候选'},
  {id:'SR-F-2026-011',name:'炭灰细格毛混纺',owner:'顾言',due:'10/09',state:'已结案',tone:'ok',sub:'2 家工厂 · 4 个候选'},
];
const NAV = [
  {g:'我的事务',items:[['home','我的工作','layout-grid',4],['cal','日历','calendar']]},
  {g:'客户与市场',closed:true,items:[['x','关系智库','share-2'],['x','客户关系管理','handshake'],['x','供应商管理','factory'],['x','季节性与趋势','trending-up']]},
  {g:'订单履约',items:[['list','开发与寻样','layers',6],['x','样品仓库','box'],['x','报价管理','receipt'],['order','订单管理','clipboard-list'],['x','生产进度','calendar-clock'],['x','QC 工作台','badge-check'],['x','货运管理','ship']]},
  {g:'财务与成本',items:[['x','财务管理','wallet'],['x','定价与利润','chart-pie']],closed:true},
  {g:'平台',items:[['x','知识库','book-open'],['x','报表中心','file-text'],['x','系统设置','settings']],closed:true},
];
const S = {view:'home', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light', collapsed:false, sel:DEVS[0], tab:'dev', stage:-1, q:'', decision:'ok', ver:'R2-A-2', palette:false, pq:'', ai:false, msgs:null, closed:{}, range:'today'};
NAV.forEach(n=>{ if(n.closed) S.closed[n.g]=true; });
const qs = new URLSearchParams(location.search);
if (qs.get('theme')) S.theme = qs.get('theme');
if (qs.get('view')) S.view = qs.get('view');

const toneCls = t => t || '';
const pill = (t, txt, plain) => `<span class="pill ${toneCls(t)} ${plain?'plain':''}">${esc(txt)}</span>`;
const prog = s => `<div class="prog">${STAGES.map((_,i)=>`<i class="${i<s?'d':i===s?'n':''}"></i>`).join('')}</div>`;
const av = (n, c='') => `<span class="av ${c}">${n}</span>`;

/* ── Shell ── */
function sidebar(){
  const active = S.view === 'detail' ? 'list' : S.view;
  return `<aside class="side">
    <div class="brand" ${S.collapsed?'data-a="collapse" role="button" tabindex="0" aria-label="展开导航"':''}>${mark()}<span class="word">Bambook<small>竹衍</small></span>
      <button class="side-toggle" data-a="collapse" aria-label="收起导航">${ic('panel-left','s')}</button></div>
    <button class="ws" data-a="toast" data-m="切换工作空间：成衣一组 / 成衣二组 / 面料组">
      <span class="ws-sym">衣</span><div><b>成衣一组</b><small>业务工作空间</small></div>${ic('chevron-down','s')}</button>
    <button class="search-btn" data-a="palette">${ic('search','s')}<span>搜索或跳转</span><kbd>⌘K</kbd></button>
    <nav class="nav" aria-label="主导航">${NAV.map(n=>`<div class="nav-group ${S.closed[n.g]?'closed':''}">
      <button class="nav-head" data-a="group" data-g="${n.g}">${n.g}${ic('chevron-down','xs')}</button>
      <div class="nav-items"><div>${n.items.map(([v,l,i,c])=>`<button class="nav-item ${v===active?'active':''}" data-a="nav" data-v="${v}" data-l="${l}" title="${l}">${ic(i)}<span>${l}</span>${c?`<span class="count">${c}</span>`:''}</button>`).join('')}</div></div></div>`).join('')}
    </nav>
    <button class="side-ai" data-a="ai"><div class="t"><span class="dot">${ic('sparkles','xs')}</span>竹衍助手</div><p>3 条建议待处理 · 已读取今日 QC 与订单动态</p></button>
    <button class="me" data-a="toast" data-m="当前演示身份：顾言 · 业务员 · 组长">${av('顾')}<div><b>顾言</b><small>业务员 · 组长</small></div>${ic('chevron-down','s')}</button>
  </aside>`;
}
const CRUMB = {home:['我的事务','我的工作'],list:['订单履约','开发与寻样'],detail:['订单履约','开发与寻样'],order:['订单履约','订单管理']};
function topbar(){
  const c = CRUMB[S.view];
  const tail = S.view==='detail' ? `${ic('chevron-right','xs')}<b class="mono">${S.sel.id}</b>` : S.view==='order' ? `${ic('chevron-right','xs')}<b class="mono">SO-G-2026-018</b>` : '';
  return `<header class="topbar" id="topbar">
    <div class="crumbs"><span class="hs">${c[0]}</span><span class="hs">${ic('chevron-right','xs')}</span>${S.view==='detail'||S.view==='order'?`<button data-a="nav" data-v="${S.view==='detail'?'list':'order'}">${c[1]}</button>`:`<b>${c[1]}</b>`}${tail}</div>
    <div class="top-actions">
      <span class="sync"><i></i>已同步 · 刚刚</span>
      <button class="icon-btn" data-a="palette" aria-label="搜索">${ic('search')}</button>
      <button class="icon-btn" data-a="toast" data-m="2 条新通知：首样评审报告已回传；出运准备待核对" aria-label="通知">${ic('bell')}<span class="pip"></span></button>
      <button class="icon-btn" data-a="theme" aria-label="${S.theme==='dark'?'切换浅色':'切换深色'}">${ic(S.theme==='dark'?'sun':'moon')}</button>
      <button class="ask-btn" data-a="ai">${ic('sparkles','s')}<span>问竹衍</span></button>
    </div></header>`;
}

/* ── Home ── */
function spark(pts){
  const w=96,h=28,max=Math.max(...pts),min=Math.min(...pts);
  const xy=pts.map((p,i)=>[i*(w/(pts.length-1)),h-3-((p-min)/(max-min||1))*(h-8)]);
  const d=xy.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><path d="${d} L${w} ${h} L0 ${h}Z" fill="url(#sg)"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
function home(){
  const d = DEVS[0];
  const tasks = [
    ['今天',1,'确认大衣改版样','Cedar & Crown · DEV-G-2026-031 · R2-A-2','blue','需求方确认',['顾','客'],'detail',0],
    ['今天',1,'核对返样尺寸','Cedar & Crown · DEV-G-2026-029 · R2-B-1','','实物返样',['顾','沈'],'detail',4],
    ['10/14',0,'跟进新样复验','Cedar & Crown · DEV-G-2026-021 · R2-A-2','warn','QC 结果',['顾','QC'],'detail',1],
    ['10/16',0,'核对订单出运准备','Cedar & Crown · SO-G-2026-018','','业务交接',['顾','后'],'order'],
  ];
  return `<div class="page">
    <section class="page-head greet"><div class="lead"><span class="eyebrow">2026 年 10 月 12 日 · 星期一 · 成衣一组</span>
      <h1 class="h1">下午好，<em>顾言</em></h1><p class="sub">今天有 4 件事等你推进，其中 2 件今天到期。Cedar & Crown 正在等待大衣改版样的确认。</p></div>
      <div class="acts"><div class="seg" role="tablist">${[['today','今天'],['week','本周']].map(([k,l])=>`<button class="${S.range===k?'on':''}" data-a="range" data-k="${k}">${l}</button>`).join('')}</div>
      <button class="btn primary" data-a="toast" data-m="新建：开发案 / 面料寻样 / 订单 / 任务">${ic('plus','s')}新建</button></div></section>
    <section class="stats">
      ${[['layers','在途开发案','6','个','2 个本周到期',[3,4,4,5,5,6,6],'list','+1'],
         ['badge-check','待 QC 评审','2','项','R1-A-2 · R2-A-2',[1,2,1,3,2,2,2],'list',''],
         ['ship','本周出运','1','单','SO-G-2026-018 · 10/16',[0,1,1,0,2,1,1],'order',''],
         ['wallet','应收待核销','48,260','USD','2 张发票 · 1 笔到账',[62,58,60,55,51,50,48],'order','−8%']]
        .map(([i,l,v,u,f,p,go,dl])=>`<button class="card stat" data-a="nav" data-v="${go}"><div class="top"><span class="ic">${ic(i,'s')}</span>${l}${dl?`<span class="delta" style="color:${dl[0]==='+'?'var(--ok-ink)':'var(--accent-ink)'}">${dl}</span>`:''}</div>
          <div class="v">${v}<small>${u}</small></div><div class="foot"><span>${f}</span>${spark(p)}</div></button>`).join('')}
    </section>
    <section class="grid">
      <article class="hero c8">${mark('ring')}
        <img class="garment" src="${IMG.coat}" alt="双面羊毛城市大衣 · 返样实物">
        <div class="meta"><span class="tag">当前焦点</span><span class="mono">${d.id}</span><span>·</span><span>Cedar & Crown</span></div>
        <h2>双面羊毛城市大衣<br>等待需求方确认 R2-A-2</h2>
        <p class="desc">QC-G-2026-0086 已通过，江南成衣返样 2 件。确认后进入成果留档，可作为转单依据。</p>
        <div class="steps">${STAGES.map((s,i)=>`<div class="${i<3?'done':i===3?'now':''}"><i></i>${s}</div>`).join('')}</div>
        <div class="cta"><button class="btn white" data-a="open" data-i="0">去确认 ${ic('arrow-right','s')}</button><button class="btn glass" data-a="toast" data-m="已打开 QC-G-2026-0086 报告预览">${ic('file-text','s')}QC 报告</button></div>
      </article>
      <article class="card brief c4"><div class="card-h"><span class="badge">${ic('sparkles','s')}</span><div><div class="h2">今日简报</div><small class="muted">竹衍助手 · 13:40 更新</small></div></div>
        <ul>
          <li data-a="open" data-i="0"><span class="n">1</span><span><b>大衣 R2-A-2</b> 全部尺寸在公差内，可直接推进需求方确认。</span></li>
          <li data-a="open" data-i="1"><span class="n">2</span><span><b>细格 Blazer</b> 袖长偏差 +1.2cm，新样预计 10/14 到，建议今天提醒江南成衣。</span></li>
          <li data-a="nav" data-v="order"><span class="n">3</span><span><b>SO-G-2026-018</b> 报关资料缺 1 份，出运前需后勤补齐。</span></li>
        </ul>
        <button class="ask" data-a="ai">${ic('message-square','s')}问问这些事的来龙去脉…<span class="go">${ic('arrow-up-right','s')}</span></button>
      </article>
      <article class="card c8"><div class="card-h"><div class="h2">接着完成</div><span class="muted" style="font-size:13px">${tasks.length} 项</span><div class="tools"><button class="btn quiet sm" data-a="toast" data-m="已按截止时间排序">${ic('sliders-horizontal','s')}排序</button></div></div>
        <div class="tasks">${tasks.map(([w,today,t,dd,tone,sc,ppl,go,idx])=>`<button class="task" data-a="${go==='order'?'nav':'open'}" data-v="order" data-i="${idx??''}">
          <span class="when ${today?'today':''}">${w}</span><div><div class="t">${t}</div><div class="d">${dd}</div></div>
          ${pill(tone,sc)}<span class="stack">${ppl.map((p,i)=>av(p,['','b','c','d'][i+1])).join('')}</span><span class="go">${ic('arrow-right','s')}</span></button>`).join('')}</div>
      </article>
      <article class="card c4"><div class="card-h"><div class="h2">今日安排</div><div class="tools"><button class="link" data-a="toast" data-m="日历模块不在本次 Demo 范围">日历 ${ic('arrow-up-right','xs')}</button></div></div>
        <div class="week">${[['一',12,2],['二',13,1],['三',14,2],['四',15,0],['五',16,3],['六',17,0],['日',18,0]].map(([w,n,k],i)=>`<button class="${i===0?'on':''}" data-a="toast" data-m="10 月 ${n} 日：${k} 项安排"><span>${w}</span><b>${n}</b><span class="dots">${'<i></i>'.repeat(k)}</span></button>`).join('')}</div>
        <div class="agenda">
          <div class="ev"><span class="tm">14:00</span><div class="box"><b>秋冬首样评审</b><small>顾言、沈禾、QC 许言 · 30 分钟</small></div></div>
          <div class="ev"><span class="tm">16:30</span><div class="box alt"><b>与客户核对领型反馈</b><small>Cedar & Crown · 大衣 R2-A-2</small></div></div>
          <div class="ev"><span class="tm">18:00</span><div class="box mute"><b>周报草稿</b><small>竹衍助手已生成初稿</small></div></div>
        </div></article>
    </section></div>`;
}

/* ── List ── */
function list(){
  const counts = STAGES.map((_,i)=>DEVS.filter(d=>d.stage===i).length);
  const dots = ['var(--ink-4)','var(--mist-1)','var(--warn)','var(--accent)','var(--ok)'];
  let rows = DEVS.filter(d=>(S.stage<0||d.stage===S.stage) && (!S.q || (d.name+d.id+d.style).toLowerCase().includes(S.q.toLowerCase())));
  const d = S.sel;
  const body = S.tab==='dev' ? `
    <div class="pipeline">${[['全部',DEVS.length,-1,'var(--ink-2)'],...STAGES.map((s,i)=>[s,counts[i],i,dots[i]])].map(([l,n,i,c])=>`<button class="${S.stage===i?'on':''}" data-a="stage" data-k="${i}"><small><i style="background:${c}"></i>${l}</small><b>${n}</b></button>`).join('')}</div>
    <div class="split"><div class="card">
      <div class="thead"><span>开发对象</span><span>负责人</span><span>阶段</span><span>目标日期</span><span>当前状态</span><span></span></div>
      ${rows.length?rows.map(r=>`<button class="row ${r.id===d.id?'sel':''}" data-a="select" data-i="${DEVS.indexOf(r)}" data-dbl="1">
        <div class="obj"><span class="thumb"><img src="${IMG[r.img]}" alt=""></span><div><div class="nm">${r.name}</div><div class="sm"><span class="mono">${r.style}</span> · ${r.id}</div></div></div>
        <span class="stack">${av(r.owner[0], r.owner==='沈禾'?'b':'')}</span>
        <div class="stage-cell">${prog(r.stage)}<small>${STAGES[r.stage]} · ${r.ver}</small></div>
        <div class="due ${r.dueRel.startsWith('2')?'late':''}"><b>${r.due}</b><small>${r.dueRel}</small></div>
        <span>${pill(r.tone,r.state)}</span><span class="go">${ic('chevron-right','s')}</span></button>`).join(''):`<div class="empty">没有符合条件的开发案。<br><button class="link" data-a="clear" style="margin-top:8px">清除筛选</button></div>`}
      <div class="tfoot"><span>${rows.length} 个开发案 · 成衣一组</span><button class="link" data-a="toast" data-m="已导出开发名单（演示）">${ic('download','xs')}导出</button><span class="pg"><button class="icon-btn" aria-label="上一页">${ic('chevron-left','s')}</button>1 / 1<button class="icon-btn" aria-label="下一页">${ic('chevron-right','s')}</button></span></div>
    </div>
    <aside class="card preview"><div class="stage">${pill(d.tone,d.state)}<span class="ver">${d.ver}</span><img src="${IMG[d.img]}" alt="${d.name}" key="${d.id}"></div>
      <div class="pv-b"><span class="mono muted" style="font-size:12px">${d.style}</span><div class="h2" style="font-size:19px;margin-top:4px">${d.name}</div>
        <p class="sub" style="font-size:13px;margin-top:8px">${d.goal}</p>
        <div class="facts"><div><small>负责人</small><b>${d.owner}</b></div><div><small>目标日期</small><b>${d.due}</b></div><div><small>工厂</small><b>${d.factory}</b></div><div><small>参与工厂</small><b>${d.fac} 家</b></div></div>
        <button class="btn primary" style="width:100%;justify-content:center" data-a="open" data-i="${DEVS.indexOf(d)}">打开开发案 ${ic('arrow-right','s')}</button></div></aside></div>`
  : `<div class="card">${FABRICS.map(f=>`<button class="row" data-a="toast" data-m="面料寻样详情不在本次 Demo 范围"><div class="obj"><span class="thumb">${ic('layers')}</span><div><div class="nm">${f.name}</div><div class="sm"><span class="mono">${f.id}</span> · ${f.sub}</div></div></div><span class="stack">${av(f.owner[0])}</span><span></span><div class="due"><b>${f.due}</b></div><span>${pill(f.tone,f.state)}</span><span class="go">${ic('chevron-right','s')}</span></button>`).join('')}</div>`;
  return `<div class="page"><section class="page-head"><div class="lead"><span class="eyebrow">订单履约 · 开发</span><h1 class="h1">开发与寻样</h1><p class="sub">从需求到留档，每一版都可追溯到工厂、实物与报告。</p></div>
    <div class="acts"><button class="btn ghost" data-a="toast" data-m="新建面料寻样（演示）">${ic('layers','s')}面料寻样</button><button class="btn primary" data-a="toast" data-m="新建开发案（演示）">${ic('plus','s')}新建开发案</button></div></section>
    <div class="tabs"><button class="${S.tab==='dev'?'on':''}" data-a="tab" data-k="dev">开发案 <span>${DEVS.length}</span></button><button class="${S.tab==='fab'?'on':''}" data-a="tab" data-k="fab">面料寻样 <span>${FABRICS.length}</span></button></div>
    <div class="toolbar"><label class="field">${ic('search','s')}<input id="q" placeholder="名称、客户款式或编号" value="${esc(S.q)}"></label>
      <button class="chip" data-a="toast" data-m="负责人筛选（演示）">负责人 <b>全部</b>${ic('chevron-down','xs')}</button>
      <button class="chip" data-a="toast" data-m="客户筛选（演示）">客户 <b>Cedar & Crown</b>${ic('chevron-down','xs')}</button>
      <div class="right"><div class="seg"><button class="on" aria-label="列表视图">${ic('list','s')}</button><button data-a="toast" data-m="看板视图（演示）" aria-label="看板视图">${ic('columns-3','s')}</button></div></div></div>
    ${body}</div>`;
}

/* ── Detail ── */
function detail(){
  const d = S.sel, cur = d.stage;
  const vers = d.id==='DEV-G-2026-031' ? ['R2-A-2','R2-B-1','R1-A-1'] : [d.ver];
  const meas = [['胸围','112.0','112.4',.55,0],['衣长','104.0','103.6',.42,0],['袖长','63.5','64.1',.63,1],['肩宽','46.0','46.2',.53,0]];
  return `<div class="page">
    <button class="back" data-a="nav" data-v="list">${ic('arrow-left','s')}开发与寻样</button>
    <section class="idrow"><span class="thumb"><img src="${IMG[d.img]}" alt=""></span>
      <div class="ttl"><div class="meta"><span>Cedar & Crown</span><i></i><span class="mono">${d.id}</span><i></i><span class="mono">${d.style}</span></div><h1 class="h1">${d.name}</h1></div>
      <div class="people"><div><small>负责人</small><b>${av(d.owner[0])}${d.owner}</b></div><div><small>目标日期</small><b>${d.due} · ${d.dueRel}</b></div><div><small>状态</small><b>${pill(d.tone,d.state)}</b></div>
      <button class="icon-btn" data-a="toast" data-m="更多：复制链接 / 转交 / 归档" aria-label="更多">${ic('ellipsis')}</button></div></section>
    <nav class="card stepper">${STAGES.map((s,i)=>`<button class="step ${i<cur?'done':i===cur?'now':''}" data-a="toast" data-m="${s}：${i<cur?'已完成':i===cur?'进行中':'未开始'}"><span class="k">${i<cur?ic('check','s'):'0'+(i+1)}</span><span><b>${s}</b><small>${i<cur?'已完成':i===cur?'进行中':'未开始'}</small></span></button>`).join('')}</nav>
    <div class="dgrid">
      <div><article class="card objcard"><div class="stage"><img src="${IMG[d.img]}" alt="${d.name}"><span class="cap">返样实物 · ${S.ver}</span></div>
        <div class="vers">${vers.map(v=>`<button class="${v===S.ver?'on':''}" data-a="ver" data-k="${v}">${v}</button>`).join('')}</div>
        <div class="kv"><div><span>工厂</span><b>${d.factory}</b></div><div><span>样品</span><b class="mono">${d.sample} · 2 件</b></div><div><span>尺码</span><b>M</b></div><div><span>面料</span><b>${d.fabric}</b></div></div></article>
        <article class="card"><div class="card-h"><div class="h2">开发目标</div></div><p class="sub" style="padding:10px 22px 20px;font-size:13.5px">${d.goal}</p></article></div>
      <div><article class="card action"><div class="top"><div style="flex:1"><span class="eyebrow">04 · 需求方确认</span><h2 class="h1">确认这一版。</h2>
          <div class="src"><b style="font-weight:500;color:var(--ink)">${d.factory} · ${S.ver}</b><span class="sep"></span>${pill('ok','QC 通过')}<span class="sep"></span><button class="link" data-a="toast" data-m="已打开 QC-G-2026-0086">${ic('file-text','xs')}QC-G-2026-0086</button></div></div></div>
        <div class="decide">${[['ok','认可','进入成果留档','circle-check'],['mod','需修改','发起新一版','pencil'],['no','不采用','保留原因记录','x']].map(([k,l,s,i])=>`<button class="${S.decision===k?'on':''}" data-a="decide" data-k="${k}"><b>${ic(i,'s')}${l}<span class="rad"></span></b><small>${s}</small></button>`).join('')}</div>
        <div class="form"><label>实际确认人<span class="in">${ic('users','s')}<input placeholder="客户或需求方联系人" value="Emma Clarke"></span></label>
          <label>所属组织<span class="in">${ic('building-2','s')}<input value="Cedar & Crown"></span></label>
          <label>确认时间<span class="in">${ic('clock','s')}<input value="2026-10-12 15:20"></span></label>
          <label>确认依据<span class="in">${ic('paperclip','s')}<input placeholder="客户反馈附件或记录名称" value="邮件 · Re: AW27 Coat R2 fitting"></span></label>
          <label class="full">需求方原文<span class="in ta"><textarea placeholder="记录认可意见、修改要求或不采用原因">Collar and shoulder line look right. Hand feel approved — please proceed with R2-A-2 for bulk.</textarea></span></label></div>
        <div class="foot"><span class="note">${ic('shield-check','xs')}顾言登记 · 对应本版实物与报告</span><span class="sp"></span><button class="btn quiet" data-a="toast" data-m="草稿已保存">存为草稿</button><button class="btn primary" data-a="confirm">保存确认 ${ic('arrow-right','s')}</button></div></article>
        <article class="card qc"><div class="card-h"><div class="h2">QC 评审</div>${pill('ok','通过')}<div class="tools"><span class="muted" style="font-size:12.5px">许言 · 10/11 17:02</span></div></div>
          <div class="sum"><div><small>测量点</small><b>24</b></div><div><small>公差内</small><b>23</b></div><div><small>需关注</small><b style="color:var(--warn-ink)">1</b></div><div><small>外观缺陷</small><b>0</b></div></div>
          <div class="meas"><div class="mrow h"><span>部位</span><span>标准</span><span>实测</span><span>公差 ±1.0cm</span><span style="text-align:right">偏差</span></div>
          ${meas.map(([p,a,b,x,w])=>`<div class="mrow"><span>${p}</span><span class="muted">${a}</span><span>${b}</span><span class="tol"><i class="${w?'w':''}" style="left:${x*100}%"></i></span><span class="dv ${w?'w':''}">${(b-a>0?'+':'')+(b-a).toFixed(1)}</span></div>`).join('')}</div></article></div>
      <div class="rail"><article class="card"><div class="card-h"><div class="h2">动态</div><div class="tools"><button class="icon-btn" aria-label="历史" data-a="toast" data-m="完整历史（演示）">${ic('history','s')}</button></div></div>
        <div class="timeline">
          <div class="tl">${av('QC','d')}<div><b>许言</b> <small>· 昨天 17:02</small><p>上传 QC 评审报告，结论：通过。袖长 +0.6cm 在公差内。</p><div class="att">${ic('file-check','s')}QC-G-2026-0086.pdf</div></div></div>
          <div class="tl">${av('江','c')}<div><b>江南成衣</b> <small>· 10/10</small><p>R2-A-2 返样 2 件已签收，存放样品仓 A-03。</p></div></div>
          <div class="tl">${av('顾')}<div><b>顾言</b> <small>· 10/03</small><p>根据客户领型反馈发起改版 R2，同时下发两家工厂。</p></div></div>
          <div class="tl">${av('沈','b')}<div><b>沈禾</b> <small>· 09/26</small><p>面料寻样 SR-F-2026-016 确认，双面羊毛浅石色。</p></div></div>
        </div></article>
        <article class="card"><div class="card-h"><div class="h2">关联</div></div><div class="rel">
          <button data-a="toast" data-m="面料寻样 SR-F-2026-016"><span class="ic">${ic('layers','s')}</span><span><b>SR-F-2026-016</b><small>面料寻样 · 待发起人确认</small></span>${ic('chevron-right','s go')}</button>
          <button data-a="toast" data-m="样品 SP-G-2026-0446"><span class="ic">${ic('box','s')}</span><span><b>SP-G-2026-0446</b><small>样品仓 A-03 · 2 件</small></span>${ic('chevron-right','s go')}</button>
          <button data-a="nav" data-v="order"><span class="ic">${ic('clipboard-list','s')}</span><span><b>SO-G-2026-018</b><small>确认后可转入订单</small></span>${ic('chevron-right','s go')}</button>
        </div></article></div>
    </div></div>`;
}

/* ── Order ── */
function order(){
  const nodes=[['下单','10/02','handshake',2],['采购','10/06','package',2],['生产','进行中','factory',1],['尾期 QC','10/28','badge-check',0],['出运','11/08','ship',0],['收款','11/30','wallet',0]];
  const lines=[['双面羊毛城市大衣','CC-AW27-COAT-014','coat',1200,'64.00',72,18],['雾蓝精纺羊毛西装','CC-AW27-SUIT-006','suit',800,'48.50',58,10],['炭灰细格轻结构 Blazer','CC-AW27-CHECK-003','blazer',600,'42.00',35,0]];
  return `<div class="page"><section class="page-head"><div class="lead"><span class="eyebrow">订单履约 · 订单</span><h1 class="h1">SO-G-2026-018</h1><p class="sub">Cedar & Crown · AW27 首批 · 3 个条目 · 负责人 顾言</p></div>
    <div class="acts"><button class="btn ghost" data-a="toast" data-m="装箱单草稿已打开">${ic('file-text','s')}装箱单</button><button class="btn primary" data-a="toast" data-m="已通知后勤核对出运准备">${ic('send','s')}交接后勤</button></div></section>
    <section class="card ohead"><div><small>订单金额</small><div class="big">140,800<small class="muted">USD</small></div><div class="hint">FOB 上海 · T/T 30/70</div></div>
      <div><small>总数量</small><div class="big">2,600<small class="muted">件</small></div><div class="hint">3 个条目</div></div>
      <div><small>交期</small><div class="big">11/08</div><div class="hint">剩余 27 天</div></div>
      <div><small>整体进度</small><div class="big">58<small class="muted">%</small></div><div class="hint" style="color:var(--ok-ink)">按计划</div></div></section>
    <section class="card" style="margin-bottom:18px"><div class="card-h"><div class="h2">履约进度</div><div class="tools">${pill('blue','生产中')}</div></div>
      <div class="flow">${nodes.map(([l,s,i,st],k)=>`${k?`<span class="bar ${st?'d':''}"></span>`:''}<div class="node ${st===2?'done':st===1?'now':''}"><span class="k">${st===2?ic('check'):ic(i)}</span><b>${l}</b><small>${s}</small></div>`).join('')}</div></section>
    <section class="grid ord-grid">
      <article class="card c8"><div class="card-h"><div class="h2">条目</div><div class="tools"><span class="muted" style="font-size:12.5px">生产 <span style="color:var(--accent-ink)">●</span> · 已 QC <span style="color:var(--ok)">●</span></span></div></div>
        <div class="lrow h"><span>款式</span><span class="r">数量</span><span class="r">单价 USD</span><span>生产进度</span><span class="r">小计</span></div>
        ${lines.map(([n,s,im,q,p,g,qc])=>`<div class="lrow"><div class="obj"><span class="thumb">${`<img src="${IMG[im]}" alt="">`}</span><div><div class="nm">${n}</div><div class="sm mono">${s}</div></div></div><span class="r">${q.toLocaleString()}</span><span class="r">${p}</span>
          <div class="meter"><div class="tr"><i style="width:${qc}%" class="q"></i><i style="width:${g-qc}%"></i></div><span>${g}% · 已 QC ${qc}%</span></div><b class="r" style="font-weight:500">${(q*p).toLocaleString('en-US',{maximumFractionDigits:0})}</b></div>`).join('')}
      </article>
      <div class="c4" style="display:flex;flex-direction:column;gap:18px">
        <article class="card"><div class="card-h"><div class="h2">出运准备</div><div class="tools"><span class="muted" style="font-size:12.5px">2 / 5</span></div></div>
          <div class="check">${[['装箱单草稿',1,'顾言'],['唛头确认',1,'客户'],['尾期 QC 预约',0,'10/28'],['报关资料',0,'缺 1 份'],['订舱',0,'后勤']].map(([l,ok,s])=>`<div class="${ok?'ok':''}"><span class="bx">${ok?ic('check','xs'):''}</span><span>${l}</span><small style="${!ok&&s.startsWith('缺')?'color:var(--bad-ink)':''}">${s}</small></div>`).join('')}</div></article>
        <article class="card"><div class="card-h"><div class="h2">收款</div></div>
          <div class="donut"><svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--sunken)" stroke-width="5"/><circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--accent)" stroke-width="5" stroke-dasharray="30 70" stroke-dashoffset="25" stroke-linecap="round"/><text x="21" y="22.5" text-anchor="middle" font-size="7" fill="var(--ink)" font-family="Urbanist" font-weight="300">30%</text><text x="21" y="28" text-anchor="middle" font-size="2.8" fill="var(--ink-3)">已收</text></svg>
            <div class="lg"><div><i style="background:var(--accent)"></i>定金已收<b>42,240</b></div><div><i style="background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line-2)"></i>尾款待收<b>98,560</b></div><div class="muted" style="font-size:12px">尾款于提单日后 30 天</div></div></div></article>
      </div></section></div>`;
}

/* ── Overlays ── */
function palette(){
  if(!S.palette) return '';
  const q=S.pq.toLowerCase();
  const items=[...DEVS.map((d,i)=>({g:'开发案',l:d.name,s:d.id,img:d.img,a:'open',i})),{g:'订单',l:'SO-G-2026-018',s:'Cedar & Crown',icon:'clipboard-list',a:'nav',v:'order'},
    {g:'跳转',l:'我的工作',s:'G H',icon:'layout-grid',a:'nav',v:'home'},{g:'跳转',l:'开发与寻样',s:'G D',icon:'layers',a:'nav',v:'list'},{g:'操作',l:'切换深浅色',s:'⇧ T',icon:'moon',a:'theme'},{g:'操作',l:'问竹衍助手',s:'⌘ J',icon:'sparkles',a:'ai'}]
    .filter(x=>!q||(x.l+x.s).toLowerCase().includes(q));
  const groups=[...new Set(items.map(x=>x.g))];
  return `<div class="scrim" data-a="close"></div><div class="palette" role="dialog" aria-label="搜索">
    <div class="q">${ic('search')}<input id="pq" placeholder="搜索开发案、订单、客户，或输入命令…" value="${esc(S.pq)}"><kbd>ESC</kbd></div>
    ${groups.length?groups.map(g=>`<div class="grp"><small>${g}</small>${items.filter(x=>x.g===g).slice(0,4).map(x=>`<button class="it" data-a="${x.a}" data-i="${x.i??''}" data-v="${x.v||''}"><span class="ic">${x.img?`<img src="${IMG[x.img]}" alt="">`:ic(x.icon,'s')}</span>${x.l}<small class="${x.g==='开发案'?'mono':''}">${x.s}</small></button>`).join('')}</div>`).join(''):`<div class="empty">没有找到「${esc(S.pq)}」</div>`}
    <div class="ft"><span>↑↓ 选择</span><span>↵ 打开</span><span>⌘K 随时唤起</span></div></div>`;
}
const AI_INIT=[{r:'a',t:'下午好，顾言。我已读取你今天的 4 项待办、2 份 QC 报告和 SO-G-2026-018 的最新动态。<br><br>最值得先处理的是 <b>双面羊毛城市大衣 R2-A-2</b>：QC 已通过，客户邮件也已明确认可，只差你登记确认。',src:['QC-G-2026-0086','邮件 · Re: AW27 Coat R2'],act:1}];
function ai(){
  if(!S.ai) return '';
  const m=S.msgs||AI_INIT;
  return `<div class="scrim" data-a="close"></div><aside class="drawer" role="dialog" aria-label="竹衍助手">
    <div class="dh"><span class="badge">${ic('sparkles')}</span><div><b>竹衍助手</b><small>基于成衣一组的业务数据回答</small></div><button class="icon-btn" data-a="close" aria-label="关闭">${ic('x')}</button></div>
    <div class="msgs" id="msgs">${m.map(x=>x.r==='u'?`<div class="msg u">${esc(x.t)}</div>`:x.r==='t'?`<div class="msg a"><div class="bub typing"><i></i><i></i><i></i></div></div>`:`<div class="msg a"><div class="bub">${x.t}</div>${x.src?`<div class="src">${x.src.map(s=>`<span>${ic('link-2','xs')}${s}</span>`).join('')}</div>`:''}${x.act?`<div class="acts"><button class="btn primary sm" data-a="open" data-i="0">去确认</button><button class="btn ghost sm" data-a="toast" data-m="已生成确认摘要草稿">生成摘要</button></div>`:''}</div>`).join('')}</div>
    <div class="sugg">${['细格 Blazer 为什么要复验？','SO-G-2026-018 还缺什么？','起草给江南成衣的提醒'].map(s=>`<button data-a="ask" data-m="${s}">${s}</button>`).join('')}</div>
    <div class="composer"><textarea id="aiq" placeholder="问竹衍，或让它帮你做事…"></textarea><button class="go" data-a="send" aria-label="发送">${ic('arrow-up-right','s')}</button></div></aside>`;
}
const ANSWERS={
  '细格 Blazer 为什么要复验？':'QC 许言在 <b>R2-A-2</b> 的评审中记录袖长实测 64.7cm，标准 63.5cm，偏差 <b>+1.2cm</b>，超出 ±1.0cm 公差。江南成衣已按结论修正，新样预计 <b>10/14</b> 到达，到样后需重新评审。',
  'SO-G-2026-018 还缺什么？':'出运准备完成 2/5。缺口：<br>· <b>报关资料</b> 缺面料成分声明 1 份<br>· <b>尾期 QC</b> 待预约（建议 10/28）<br>· <b>订舱</b> 由后勤在 QC 后安排<br>交期 11/08，目前进度按计划。',
  '起草给江南成衣的提醒':'草稿：<br><br>“王经理您好，DEV-G-2026-021 细格 Blazer 新样请于 10/14 前寄达，重点复核袖长（目标 63.5cm ±1.0）。如有延期请提前告知，谢谢。—— 顾言”'
};
function toast(){ return S.toast ? `<div class="toast" role="status">${ic('circle-check','s')}${esc(S.toast)}</div>` : ''; }

/* ── Render ── */
const VIEWS={home,list,detail,order};
let scrollTop=0;
function render(keepScroll){
  document.documentElement.dataset.theme=S.theme;
  const sc=document.querySelector('.scroll'); if(sc&&keepScroll) scrollTop=sc.scrollTop;
  document.getElementById('root').innerHTML=`<div class="app ${S.collapsed?'collapsed':''}">${sidebar()}<main class="canvas">${topbar()}<div class="scroll" id="scroll">${VIEWS[S.view]()}</div></main></div>${palette()}${ai()}${toast()}`;
  const s2=document.getElementById('scroll');
  if(keepScroll){ s2.scrollTop=scrollTop; s2.querySelector('.page').style.animation='none'; }
  s2.addEventListener('scroll',()=>document.getElementById('topbar').classList.toggle('scrolled',s2.scrollTop>4));
  const q=document.getElementById('q'); if(q){ q.oninput=e=>{S.q=e.target.value;render(true);const n=document.getElementById('q');n.focus();n.setSelectionRange(n.value.length,n.value.length);} }
  const pq=document.getElementById('pq'); if(pq){ pq.focus(); pq.setSelectionRange(pq.value.length,pq.value.length); pq.oninput=e=>{S.pq=e.target.value;render(true);} }
  const m=document.getElementById('msgs'); if(m) m.scrollTop=m.scrollHeight;
  const aq=document.getElementById('aiq'); if(aq){ aq.onkeydown=e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(aq.value);} }; }
}
let tt; function say(t){ S.toast=t; render(true); clearTimeout(tt); tt=setTimeout(()=>{S.toast='';render(true);},2600); }
function go(v){ S.view=v; S.palette=false; S.ai=false; render(); }
function open(i){ S.sel=DEVS[+i]; S.ver=S.sel.ver==='—'?'—':S.sel.ver; S.decision='ok'; go('detail'); }
function send(t){ t=(t||'').trim(); if(!t) return; S.msgs=[...(S.msgs||AI_INIT),{r:'u',t},{r:'t'}]; render(true);
  setTimeout(()=>{ S.msgs.pop(); S.msgs.push({r:'a',t:ANSWERS[t]||'我查阅了成衣一组的开发案、QC 与订单记录。这是演示环境，真实版本会基于实时业务数据回答，并附上来源。',src:ANSWERS[t]?['开发案','QC 报告','订单']:null}); render(true); },900); }

document.addEventListener('click',e=>{
  const el=e.target.closest('[data-a]'); if(!el) return;
  const a=el.dataset.a;
  if(a==='nav'){ const v=el.dataset.v; if(VIEWS[v]) go(v); else say(`「${el.dataset.l||'该模块'}」不在本次 Demo 范围`); }
  else if(a==='open') open(el.dataset.i||0);
  else if(a==='select'){ const d=DEVS[+el.dataset.i]; if(S.sel===d){ open(el.dataset.i); } else { S.sel=d; render(true);} }
  else if(a==='theme'){ S.theme=S.theme==='dark'?'light':'dark'; S.palette=false; render(true); }
  else if(a==='collapse'){ S.collapsed=!S.collapsed; render(true); }
  else if(a==='group'){ S.closed[el.dataset.g]=!S.closed[el.dataset.g]; render(true); }
  else if(a==='palette'){ S.palette=true; S.pq=''; render(true); }
  else if(a==='ai'){ S.ai=true; S.palette=false; render(true); }
  else if(a==='close'){ S.palette=false; S.ai=false; render(true); }
  else if(a==='toast') say(el.dataset.m);
  else if(a==='range'){ S.range=el.dataset.k; render(true); }
  else if(a==='tab'){ S.tab=el.dataset.k; render(true); }
  else if(a==='stage'){ S.stage=+el.dataset.k; render(true); }
  else if(a==='clear'){ S.stage=-1; S.q=''; render(true); }
  else if(a==='ver'){ S.ver=el.dataset.k; render(true); }
  else if(a==='decide'){ S.decision=el.dataset.k; render(true); }
  else if(a==='confirm'){ const d=S.sel; if(S.decision==='ok'){ d.stage=4; d.state='已确认 · 留档'; d.tone='ok'; } else if(S.decision==='mod'){ d.state='待改版'; d.tone='warn'; } else { d.state='不采用'; d.tone='bad'; } say(S.decision==='ok'?'已确认 R2-A-2，进入成果留档':'已记录需求方意见'); }
  else if(a==='ask') send(el.dataset.m);
  else if(a==='send') send(document.getElementById('aiq').value);
});
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); S.palette=!S.palette; S.pq=''; render(true); }
  else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='j'){ e.preventDefault(); S.ai=!S.ai; render(true); }
  else if(e.key==='Escape'&&(S.palette||S.ai)){ S.palette=false; S.ai=false; render(true); }
  else if(e.key==='Enter'&&S.palette){ const b=document.querySelector('.palette .it'); if(b) b.click(); }
});
render();
if(qs.get('palette')) { S.palette=true; render(true); }
if(qs.get('ai')) { S.ai=true; render(true); }
const sp=document.getElementById('splash');
if(qs.get('intro')==='0') sp.remove(); else setTimeout(()=>{sp.classList.add('out'); setTimeout(()=>sp.remove(),700);},1500);
