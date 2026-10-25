// Costs are integer paise. Sales consume oldest purchase batches first (FIFO).
export function stockLots(data, productId) {
  const lots=[];
  for(const m of data.movements.filter(x=>x.productId===productId)) {
    if(m.direction===1) lots.push({id:m.id,at:m.at,quantity:m.quantity,remaining:m.quantity,costPaise:m.costPaise??null});
    else for(const a of m.allocations||[]) {const lot=lots.find(x=>x.id===a.lotId);if(lot) lot.remaining-=a.quantity;}
  }
  return lots;
}
export function allocate(data,productId,quantity) {
  const result=[];
  for(const lot of stockLots(data,productId)) {
    if(lot.remaining<=0)continue;
    if(lot.costPaise===null)throw new Error('Opening stock has no purchase cost. Reconcile historical stock before selling.');
    const take=Math.min(quantity,lot.remaining);
    result.push({lotId:lot.id,quantity:take,costPaise:lot.costPaise});quantity-=take;
    if(!quantity)return result;
  }
  throw new Error('Insufficient costed stock');
}
export function money(value) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>10000000||Math.abs(value*100-Math.round(value*100))>0.00001)throw new Error('Enter a valid amount with at most two decimal places');
  return Math.round(value*100);
}
