import fs from 'node:fs';import {resolveComponents} from '../business/sku-pricing.mjs';
const path='business/payload.json',data=JSON.parse(fs.readFileSync(path)),map=JSON.parse(fs.readFileSync('data/report-review.json')).records.styleMap;
const key=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');let added=0;
for(const row of map)for(const part of String(row[1]).split('&').map(s=>s.trim().replace(/^_+|_+$/g,'')).filter(Boolean)){
 const resolution=resolveComponents(part,data.products);if(resolution.complete)continue;
 if(data.products.some(p=>[p.id,p.n,...p.a].some(a=>key(a)===key(part))))continue;
 const id='stylepart_'+key(part);data.products.push({id,n:part,p:0,u:0,a:[part],extracted:true,needs_price:true});added++;
}
data.styleMap=map.map(r=>({style:String(r[0]),sku:String(r[1]),name:String(r[2])}));
fs.writeFileSync(path,JSON.stringify(data));let html=fs.readFileSync('business/combo-price-desk.html','utf8');html=html.replace(/(<script id="seed" type="application\/json">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(data).replaceAll('<','\\u003c')+b);fs.writeFileSync('business/combo-price-desk.html',html);console.log(JSON.stringify({added,products:data.products.length,styles:data.styleMap.length}));
