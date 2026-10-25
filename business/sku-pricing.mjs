const key=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function resolveComponents(sku,products){
 const aliases=new Map();products.forEach((p,i)=>[p.id,p.n,...(p.a||[])].forEach(a=>{const k=key(a);if(!k)return;const ids=aliases.get(k)||new Set();ids.add(i);aliases.set(k,ids)}));
 const sorted=[...aliases.keys()].sort((a,b)=>b.length-a.length),components=[],unknown=[];
 for(const part of String(sku).split('&').map(key).filter(Boolean)){
   const exact=aliases.get(part);if(exact?.size===1){components.push([...exact][0]);continue}
   // Fully cover each token. Never skip letters or guess trailing quantities.
   const memo=new Map();function walk(pos){if(pos===part.length)return [[]];if(memo.has(pos))return memo.get(pos);const out=[];for(const a of sorted){if(a.length<3||!part.startsWith(a,pos))continue;for(const id of aliases.get(a)){for(const tail of walk(pos+a.length)){out.push([id,...tail]);if(out.length>1)break}if(out.length>1)break}if(out.length>1)break}memo.set(pos,out);return out}
   const options=walk(0);if(options.length===1)components.push(...options[0]);else unknown.push(part);
 }
 return {components,unknown,complete:components.length>0&&!unknown.length};
}
export function pricingRow(row,products,prices,shipping,margin){
 const resolution=resolveComponents(row.sku,products),missing=resolution.components.filter(i=>!Number.isFinite(prices[i])||prices[i]<=0),complete=resolution.complete&&!missing.length;
 const productCost=complete?resolution.components.reduce((n,i)=>n+prices[i],0):null;
 const cost=complete?Math.round((productCost+shipping)*100)/100:null;
 return {...row,...resolution,missing,productCost,cost,target:complete&&margin>=0&&margin<100?Math.ceil(cost/(1-margin/100)*100)/100:null};
}
