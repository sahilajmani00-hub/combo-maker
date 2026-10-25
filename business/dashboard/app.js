const paths = {
  home:'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9',
  canvas:'M4 4h16v16H4zM12 4v16M4 12h16',
  ai:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  image:'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M8 8h.01',
  text:'M4 5h16M12 5v15M8 20h8',
  reverse:'M4 10a8 8 0 1 1 1 8M4 4v6h6',
  template:'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6',
  link:'M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2',
  drive:'m8 3 8 0 6 11-4 7H6l-4-7 6-11ZM8 3l10 18M16 3 6 21M2 14h20',
  cloud:'M7 18a5 5 0 1 1 0-10 6 6 0 0 1 12 0 5 5 0 0 1-1 10ZM12 9v7m-3-3 3 3 3-3',
  queue:'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1',
  price:'M5 3h14v18H5zM8 7h8M8 11h2M14 11h2M8 15h2M14 15h2M8 18h2M14 18h2',
  stock:'m3 7 9-4 9 4v11l-9 4-9-4ZM3 7l9 4 9-4M12 11v11M7 5l10 4',
  chart:'M4 3v18h17M8 16v-4M13 16V8M18 16V4',
  return:'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
  copy:'M8 8h13v13H8zM16 8V3H3v13h5',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"></path></svg>`;
const tools = [
  {id:'catalog-profit',name:'Product profit & loss',group:'Business',icon:'chart',description:'Catalog payout, return costs, ads and partial product-cost estimates.',frame:'catalogProfit'},
  {id:'reports',name:'Report insights',group:'Business',icon:'chart',description:'Latest order, style map, return and payout report insights.',frame:'reports'},
  {id:'control',name:'Daily control & records',group:'Business',icon:'chart',description:'Import history, SKU review, state performance and payment reconciliation.',frame:'control'},
  {id:'analysis',name:'Upload & analyze',group:'Business',icon:'chart',description:'Upload sales and order files to review delivery, returns, inventory and profit.',frame:'analysis'},
  {id:'canvas',name:'Canvas combos',group:'Create',icon:'canvas',description:'Arrange 2, 3, or 4 products. Download images or a ZIP.',frame:'combo',tab:'canvas',target:'.workspace'},
  {id:'ai',name:'AI angle combos',group:'Create',icon:'ai',description:'Re-photograph your combos with Higgsfield. Review the estimate before generating.',frame:'combo',tab:'ai',target:'.workspace'},
  {id:'descriptions',name:'Product descriptions',group:'Create',icon:'text',description:'Describe your product photos with AI, then edit the results.',frame:'combo',tab:'ai',target:'#ai-describe-button',field:true},
  {id:'prompts',name:'AI prompt writer',group:'Create',icon:'ai',description:'Write camera-angle prompts for your product combinations.',frame:'combo',tab:'ai',target:'#ai-write-button',field:true},
  {id:'reverse',name:'Prompts from images',group:'Create',icon:'reverse',description:'Use your generated images to write reusable prompts.',frame:'combo',tab:'ai',target:'#ai-reverse-folder',field:true},
  {id:'templates',name:'Photo templates',group:'Create',icon:'template',description:'Save and restore your product photos and combo settings.',frame:'combo',target:'#template-name',field:true},
  {id:'urls',name:'Product image URLs',group:'Publish',icon:'link',description:'Create image links for your products using Cloudinary.',frame:'combo',target:'.setup-panel'},
  {id:'drive',name:'Drive & listing sheets',group:'Publish',icon:'drive',description:'Upload finished folders and create marketplace listing sheets.',frame:'combo',tab:'ai',target:'#drive-folder',field:true},
  {id:'cloudinary',name:'Cloudinary',group:'Publish',icon:'cloud',description:'Connect image hosting for durable product and combo URLs.',frame:'combo',target:'#cloudinary-connect',field:true},
  {id:'queue',name:'Extension queue',group:'Publish',icon:'queue',description:'Review references, edit prompts, and track your manual generation queue.',frame:'queue'},
  {id:'pricing',name:'SKU pricing',group:'Business',icon:'price',description:'Change one product price and recalculate all your combo costs.',frame:'pricing'},
  {id:'stock',name:'Stock updates',group:'Business',icon:'stock',description:'Import product quantities, review stock, and export updated counts.',frame:'pricing'},
  {id:'operations',name:'Inventory & returns',group:'Business',icon:'return',description:'Record stock received, sales, adjustments, and customer returns.',frame:'operations'},
  {id:'payments',name:'Meesho profit & loss',group:'Business',icon:'chart',description:'Map payment columns and compare net payouts with SKU costs.',frame:'pricing'},
  {id:'copies',name:'Cost sheet copies',group:'Business',icon:'copy',description:'Save or reopen a copy of your prices, SKU list, and stock.',frame:'pricing'},
];
const priority = ['control','analysis','operations','pricing','canvas','payments','stock','copies'];
tools.sort((a,b) => (priority.includes(a.id) ? priority.indexOf(a.id) : 99) - (priority.includes(b.id) ? priority.indexOf(b.id) : 99));
const $ = id => document.getElementById(id);
const frames = new Map();
let active = null;
let health = null;
let search = '';
const sources = {combo:'/combo/',pricing:'/combo-price-desk.html',queue:'/queue/panel.html',operations:'/operations.html',analysis:'/analysis.html',control:'/control.html',reports:'/reports.html',catalogProfit:'/catalog-profit.html'};

function renderMenu() {
  const matches = tools.filter(t => `${t.name} ${t.description} ${t.group}`.toLowerCase().includes(search));
  $('navigation').innerHTML = `<a href="#overview" class="${active ? '' : 'active'}" ${active ? '' : 'aria-current="page"'}>${icon('home')}<span>Today</span></a>` +
    ['Business','Create','Publish'].map(group => {
      const list = matches.filter(t => t.group === group);
      return list.length ? `<h2>${group}</h2>` + list.map(t => `<a href="#${t.id}" class="${active?.id === t.id ? 'active' : ''}" ${active?.id === t.id ? 'aria-current="page"' : ''}>${icon(t.icon)}<span>${t.name}</span></a>`).join('') : '';
    }).join('');
  $('tool-grid').innerHTML = (search ? matches : matches.filter(t => ['control','analysis','operations','pricing','canvas','payments','stock','copies'].includes(t.id))).map(t => `<a class="tool-card" data-group="${t.group}" href="#${t.id}"><span class="tool-icon">${icon(t.icon)}</span><span class="card-arrow">↗</span><h3>${t.name}</h3><p>${t.description}</p></a>`).join('');
  $('tool-count').textContent = search ? `${matches.length} tools` : '8 core tools';
  $('no-tools').hidden = matches.length > 0;
}

async function checkHealth() {
  try {
    const r = await fetch('/health',{signal:AbortSignal.timeout(3500)});
    health = await r.json();
    $('server-status').textContent = health.combo ? 'All tools available' : 'Pricing available';
    $('status-dot').classList.toggle('ready',!!health.combo);
  } catch {
    health = null;
    $('server-status').textContent = 'Server disconnected';
    $('status-dot').classList.remove('ready');
  }
}

function prepareFrame(frame, name) {
  const doc = frame.contentDocument;
  if (!doc) throw new Error('Unable to access this workspace.');
  const style = doc.createElement('style');
  style.id='dashboard-embed-style';
  style.textContent = name === 'combo'
    ? '.topbar,.intro,footer{display:none!important}main{padding-top:18px!important}.dashboard-focus{outline:2px solid #91b29e;outline-offset:8px;border-radius:6px}'
    : name === 'queue'
      ? 'body{max-width:820px;margin:0 auto;padding:24px;font-size:13px}textarea{min-height:180px}.references img{max-height:260px;object-fit:contain}'
    : name === 'pricing' ? '.wrap[data-panel="stock"]>*,.wrap[data-panel="payments"]>*{display:none!important}.wrap[data-panel="stock"]>#stock-tools,.wrap[data-panel="payments"]>#payment-tools{display:block!important}.data-tools{margin-top:0!important}' : '';
  doc.head.append(style);
  if (name === 'pricing') {
    doc.getElementById('stockfile').closest('section').id='stock-tools';
    doc.getElementById('paymentfile').closest('section').id='payment-tools';
  }
  if (name === 'combo') {
    // Keep the sidebar in sync when the app's own Canvas / AI tabs are used.
    doc.querySelector('.mode-switch').addEventListener('click', event => {
      const tab = event.target.closest('[data-tab]');
      if (event.isTrusted && tab) location.hash=tab.dataset.tab;
    });
  }
}

async function getFrame(name) {
  if (frames.has(name)) return frames.get(name).ready;
  const frame = document.createElement('iframe');
  frame.title = name === 'combo' ? 'Combo Maker tools' : name === 'pricing' ? 'Pricing and business tools' : 'Combo Maker queue';
  frame.allow='clipboard-read; clipboard-write';
  frame.hidden=true;
  const ready = new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('The tool took too long to open. Check the local server, then retry.')),25000);
    frame.addEventListener('load', () => {
      try {
        const selector = name === 'combo' ? '#file-input' : name === 'pricing' ? '#stockfile' : name === 'operations' ? '#movement-form' : name === 'catalogProfit' ? '#catalog-summary' : name === 'reports' ? '#report-summary' : name === 'control' ? '#save' : name === 'analysis' ? '#upload' : '#refresh';
        if (!frame.contentDocument.querySelector(selector)) throw new Error('Combo Maker is unavailable. Restart with npm start, then retry.');
        prepareFrame(frame,name);
        clearTimeout(timer); resolve(frame);
      } catch(error) { clearTimeout(timer); reject(error); }
    },{once:true});
  });
  frames.set(name,{frame,ready});
  frame.src=sources[name];
  $('frames').append(frame);
  return ready;
}

async function showTool(tool) {
  $('tool-error').hidden=true;
  $('loading').hidden=false;
  for (const {frame} of frames.values()) frame.hidden=true;
  try {
    const frame = await getFrame(tool.frame);
    if (active?.id !== tool.id) return;
    frame.hidden=false;
    const doc=frame.contentDocument;
    if (tool.frame === 'pricing') {
      doc.querySelector('.wrap').dataset.panel=tool.id;
      if(tool.id==='copies'){const button=doc.getElementById('style-analyze');if(button&&!button.dataset.loaded){button.dataset.loaded='true';button.click();}}
      frame.contentWindow.scrollTo(0,0);
    } else if (tool.frame === 'combo') {
      doc.querySelectorAll('.dashboard-focus').forEach(el => el.classList.remove('dashboard-focus'));
      if (tool.tab) doc.querySelector(`[data-tab="${tool.tab}"]`).click();
      let target=doc.querySelector(tool.target);
      if (tool.field) target=target?.closest('.field');
      if (target) {
        if (tool.field) target.classList.add('dashboard-focus');
        requestAnimationFrame(() => { if (active?.id===tool.id) target.scrollIntoView({block:'start'}); });
      }
    }
    $('loading').hidden=true;
  } catch(error) {
    if (active?.id !== tool.id) return;
    $('loading').hidden=true;
    $('error-detail').textContent=error.message;
    $('tool-error').hidden=false;
  }
}

function navigate() {
  active=tools.find(t => t.id===location.hash.slice(1)) || null;
  $('overview').hidden=!!active;
  $('workspace').hidden=!active;
  $('breadcrumb').textContent=active?.name || 'Today';
  document.title=`${active?.name || 'Today'} · Combo Workspace`;
  $('sidebar').classList.remove('open');
  $('menu').setAttribute('aria-expanded','false');
  renderMenu();
  if (active) {
    $('tool-title').textContent=active.name;
    $('tool-category').textContent=active.group;
    $('tool-description').textContent=active.description;
    $('standalone').href=sources[active.frame];
    showTool(active);
  }
}

$('tool-search').addEventListener('input', e => {search=e.target.value.trim().toLowerCase(); renderMenu();});
$('menu').addEventListener('click', () => $('menu').setAttribute('aria-expanded',String($('sidebar').classList.toggle('open'))));
$('menu-backdrop').addEventListener('click', () => {$('sidebar').classList.remove('open'); $('menu').setAttribute('aria-expanded','false'); $('menu').focus();});
document.addEventListener('keydown', e => {
  if (e.key==='/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {e.preventDefault(); $('sidebar').classList.add('open'); $('menu').setAttribute('aria-expanded','true'); $('tool-search').focus();}
  if (e.key==='Escape') {$('sidebar').classList.remove('open'); $('menu').setAttribute('aria-expanded','false');}
});
$('check-status').addEventListener('click',checkHealth);
$('retry').addEventListener('click', () => {
  if (!active) return;
  frames.get(active.frame)?.frame.remove();
  frames.delete(active.frame);
  showTool(active);
});
window.addEventListener('hashchange',navigate);
navigate();
checkHealth();
setInterval(checkHealth,15000);
