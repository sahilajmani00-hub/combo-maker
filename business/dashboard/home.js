(()=>{
const el=id=>document.getElementById(id),key='combo.daily.v1';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const tasks=[
{id:'orders',title:'Update today’s orders',note:'Upload the latest order report and review delivery statuses.',href:'#control',priority:true},
{id:'payments',title:'Reconcile payments',note:'Import the latest settlement file and check unmatched orders.',href:'#control',priority:true},
{id:'returns',title:'Check returns & RTO arrivals',note:'Record physically received returns and inspect their condition.',href:'#operations',priority:true},
{id:'stock',title:'Record purchases & stock changes',note:'Enter quantities and purchase costs for each incoming batch.',href:'#operations',priority:false},
{id:'skus',title:'Review new combo SKUs',note:'Confirm component products before using them for stock deductions.',href:'#control',priority:false}
];
let store={off:{},days:{}},counts=null,error='',busy=false;
try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved&&typeof saved.off==='object'&&saved.off&&typeof saved.days==='object'&&saved.days)store=saved}catch{error='Saved checklist could not be read. New changes will start a fresh checklist.'}
function persist(){try{localStorage.setItem(key,JSON.stringify(store));return true}catch{error='Could not save your checklist. Browser storage may be full or disabled.';return false}}
function render(){const day=today(),done=store.days[day]||{},active=tasks.filter(t=>!store.off[t.id]),n=active.filter(t=>done[t.id]).length;
el('today-date').textContent=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',weekday:'long',day:'numeric',month:'long'}).format(new Date());
el('daily-summary').textContent=active.length?`${n} of ${active.length} completed today${n===active.length?' · All daily reviews done.':''}`:'All reminders are off. Turn them on below when needed.';
el('daily-alert').textContent=error;
el('daily-tasks').innerHTML=active.map(t=>{const badge=t.priority?'Important':'Daily';let detail=t.note;if(counts&&t.id==='payments')detail+=` ${counts.payments} orders have no payment entry.`;if(counts&&t.id==='skus')detail+=` ${counts.skus} SKUs need review.`;if(counts&&t.id==='returns')detail+=` ${counts.returns} orders currently have return or RTO status.`;return `<article class="daily-task ${done[t.id]?'completed':t.priority?'important':''}"><label class="daily-check"><input type="checkbox" data-done="${t.id}" ${done[t.id]?'checked':''} aria-label="Mark ${t.title} done"></label><div class="daily-copy"><span class="daily-badge">${done[t.id]?'Done':badge}</span><h2>${t.title}</h2><p>${detail}</p></div><a class="secondary" href="${t.href}">Open ↗</a></article>`}).join('');
el('daily-toggles').innerHTML=tasks.map(t=>`<label class="daily-toggle"><span>${t.title}</span><input type="checkbox" role="switch" data-toggle="${t.id}" ${store.off[t.id]?'':'checked'} aria-label="${t.title} reminder"><b>${store.off[t.id]?'Off':'On'}</b></label>`).join('');
el('daily-history').replaceChildren();const dates=Object.keys(store.days).sort().reverse().slice(0,14);for(const date of dates){const p=document.createElement('p');const completed=tasks.filter(t=>store.days[date]?.[t.id]);p.textContent=`${date}: ${completed.length?completed.map(t=>t.title).join(' · '):'No tasks completed'}`;el('daily-history').append(p)}if(!dates.length)el('daily-history').textContent='No completed tasks yet.';
el('daily-tasks').querySelectorAll('[data-done]').forEach(input=>input.onchange=()=>{store.days[today()]??={};if(input.checked)store.days[today()][input.dataset.done]=new Date().toISOString();else delete store.days[today()][input.dataset.done];persist();render()});
el('daily-toggles').querySelectorAll('[data-toggle]').forEach(input=>input.onchange=()=>{store.off[input.dataset.toggle]=!input.checked;persist();render()});
}
async function refresh(){if(busy)return;busy=true;el('refresh-tasks').disabled=true;try{const r=await fetch('/api/records',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();const d=await r.json(),orders=Object.values(d.orders);counts={payments:orders.filter(o=>o.current&&(!o.current.reportedPayoutStatus||o.current.reportedPayoutStatus==='PENDING')&&!o.payments.length).length,skus:Object.values(d.skus).filter(s=>!s.confirmed).length,returns:orders.filter(o=>/return|rto/i.test(o.current?.status||'')).length};error=''}catch{counts=null;error='Live counts unavailable. You can still use your checklist.'}finally{busy=false;el('refresh-tasks').disabled=false;render()}}
el('refresh-tasks').onclick=refresh;window.addEventListener('hashchange',()=>{if(!location.hash||location.hash==='#overview')refresh()});window.addEventListener('storage',e=>{if(e.key===key){try{const v=JSON.parse(e.newValue);if(v?.off&&v?.days)store=v;render()}catch{}}});setInterval(render,60000);render();refresh();
})();
