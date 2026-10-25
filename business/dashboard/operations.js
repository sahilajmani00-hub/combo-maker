const $ = id => document.getElementById(id);
let state;
const rupees = n => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(n);
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nameOf = id => state.catalog.products.find(p=>p.id===id)?.n || id;
function prices() { try { return JSON.parse(localStorage.getItem('cpd.prices')||'{}').prices||{}; } catch { return {}; } }
async function load() {
  const response = await fetch('/api/operations');
  if (!response.ok) throw new Error('Could not load operations');
  state = await response.json();
  render();
}
function render() {
  const products=state.catalog.products;
  const options=products.map(p=>`<option value="${esc(p.id)}">${esc(p.n)}</option>`).join('');
  document.querySelectorAll('select[name="productId"]').forEach(select=>{const current=select.value;select.innerHTML=options;select.value=current||products[0]?.id;});
  document.querySelector('[name="saleId"]').innerHTML='<option value="">Choose original sale</option>'+state.movements.filter(m=>m.reason==='sold').map(m=>`<option value="${m.id}">${esc(nameOf(m.productId))} · ${m.quantity} units · ${new Date(m.at).toLocaleString('en-IN')}</option>`).join('');
  $('lot-rows').innerHTML=state.lots.map(l=>`<tr><td>${esc(nameOf(l.productId))}</td><td>${new Date(l.at).toLocaleString('en-IN')}</td><td>${l.costPaise===null?'Unknown':rupees(l.costPaise/100)}</td><td>${l.quantity}</td><td>${l.remaining}</td><td>${l.quantity-l.remaining}</td></tr>`).join('');
  let units=0;
  const rows=products.map(p=>{
    const onHand=state.movements.filter(m=>m.productId===p.id).reduce((n,m)=>n+m.quantity*m.direction,0);
    const returns=state.returns.filter(r=>r.productId===p.id).reduce((n,r)=>n+r.quantity,0);
    units+=onHand;
    return {p,onHand,returns,price:onHand ? state.lots.filter(l=>l.productId===p.id).reduce((n,l)=>n+l.remaining*(l.costPaise||0),0)/100/onHand : 0};
  });
  $('product-count').textContent=products.length;
  $('unit-count').textContent=units.toLocaleString('en-IN');
  $('return-count').textContent=state.returns.reduce((n,r)=>n+r.quantity,0).toLocaleString('en-IN');
  $('refund-total').textContent=rupees(state.returns.reduce((n,r)=>n+r.refund,0));
  const q=$('search').value.trim().toLowerCase();
  $('stock-rows').innerHTML=rows.filter(x=>x.p.n.toLowerCase().includes(q)||x.p.id.includes(q)).map(({p,onHand,returns,price})=>`<tr><td>${esc(p.n)}</td><td>${onHand}</td><td>${returns}</td><td>${rupees(price)}</td><td>${rupees(onHand*price)}</td></tr>`).join('')||'<tr><td colspan="5">No products found</td></tr>';
  const activity=[...state.movements.filter(m=>m.reason!=='return').map(m=>({...m,kind:m.reason})),...state.returns.map(r=>({...r,kind:'return'}))].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,50);
  $('activity-rows').innerHTML=activity.map(a=>`<tr><td>${new Date(a.at).toLocaleString('en-IN')}</td><td>${esc(a.kind)}</td><td>${esc(nameOf(a.productId))}</td><td>${a.direction===-1?'-':'+'}${a.quantity}</td><td>${esc(a.note||a.orderId||'—')}</td></tr>`).join('')||'<tr><td colspan="5">No activity yet</td></tr>';
}
async function submit(form,type) {
  const v=Object.fromEntries(new FormData(form));
  const body={type,productId:v.productId,quantity:Number(v.quantity),note:v.note||''};
  if(type==='movement'){body.unitCost=v.unitCost===''?null:Number(v.unitCost);body.reason=v.action.startsWith('adjustment')?'adjustment':v.action;body.direction=['sold','adjustment-out'].includes(v.action)?-1:1;}
  else {body.saleId=v.saleId;body.disposition=v.disposition;body.orderId=v.orderId||'';body.refund=Number(v.refund);}
  const response=await fetch('/api/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok) throw new Error(await response.text());
  form.reset(); await load(); $('message').textContent='Entry saved.';
}
for(const [id,type] of [['movement-form','movement'],['return-form','return']]) $(id).addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type=submit]');if(button.disabled)return;button.disabled=true;try{await submit(form,type)}catch(err){$('message').textContent=err.message}finally{button.disabled=false}});
$('search').addEventListener('input',()=>state&&render());
$('export').addEventListener('click',()=>{
  if(!state)return;
  const rows=[['Date','Type','Product ID','Product','Quantity','Direction','Disposition','Refund','Order ID','Note'],...state.movements.filter(m=>m.reason!=='return').map(m=>[m.at,m.reason,m.productId,nameOf(m.productId),m.quantity,m.direction,'','','',m.note]),...state.returns.map(r=>[r.at,'return',r.productId,nameOf(r.productId),r.quantity,r.disposition==='restock'?1:0,r.disposition,r.refund,r.orderId,r.note])];
  const csv=rows.map(row=>row.map(cell=>'"'+String(cell??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='inventory-returns.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});
load().catch(err=>{$('message').textContent=err.message});
