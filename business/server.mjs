import { revalueAnalysis } from './revalue-analysis.mjs'
import { currentCatalog, priceState, savePrices } from './catalog-store.mjs'
import { records } from './records.mjs'
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { stockLots, allocate, money } from './costing.mjs'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
const dataFile = resolve(process.env.BUSINESS_DATA_DIR || resolve(root,'../data'), 'operations.json')
const catalog = JSON.parse(readFileSync(resolve(root, 'payload.json'), 'utf8'))
const productIds = new Set(catalog.products.map(p => p.id))
const files = new Map([
  ['/dashboard/sku-pricing.mjs','sku-pricing.mjs'],
  ['/catalog-profit.html','dashboard/catalog-profit.html'],
  ['/dashboard/catalog-profit.js','dashboard/catalog-profit.js'],
  ['/reports.html','dashboard/reports.html'],
  ['/dashboard/reports.js','dashboard/reports.js'],
  ['/dashboard/home.js','dashboard/home.js'],
  ['/control.html','dashboard/control.html'],
  ['/dashboard/control.js','dashboard/control.js'],
  ['/analysis.html', 'dashboard/analysis.html'],
  ['/dashboard/analysis.js', 'dashboard/analysis.js'],
  ['/dashboard/xlsx.js', 'dashboard/xlsx.js'],
  ['/', 'dashboard/index.html'],
  ['/index.html', 'dashboard/index.html'],
  ['/dashboard/style.css', 'dashboard/style.css'],
  ['/dashboard/app.js', 'dashboard/app.js'],
  ['/dashboard/queue-adapter.js', 'dashboard/queue-adapter.js'],
  ['/operations.html', 'dashboard/operations.html'],
  ['/dashboard/operations.css', 'dashboard/operations.css'],
  ['/dashboard/operations.js', 'dashboard/operations.js'],
  ['/combo-price-desk.html', 'combo-price-desk.html'],
])
const types = { html:'text/html', css:'text/css', js:'text/javascript', mjs:'text/javascript', png:'image/png' }
function send(res,status,body,type='text/plain') {
  res.writeHead(status, {'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'})
  res.end(body)
}
function readOperations() {
  try { return JSON.parse(readFileSync(dataFile,'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return {movements:[],returns:[]}; throw error }
}
function saveOperations(data) {
  mkdirSync(dirname(dataFile),{recursive:true})
  const temp=dataFile+'.tmp'
  writeFileSync(temp,JSON.stringify(data,null,2))
  renameSync(temp,dataFile)
}
async function jsonBody(req) {
  let raw=''
  for await (const chunk of req) {raw+=chunk; if(raw.length>100_000) throw new Error('Request too large')}
  return JSON.parse(raw)
}
export async function handleBusiness(req,res,pathname,dist,extension) {
  if(pathname==='/api/prices'){if(req.method==='GET'){send(res,200,JSON.stringify(priceState()),'application/json')}else if(req.method==='POST'){try{send(res,200,JSON.stringify(savePrices(await jsonBody(req))),'application/json')}catch(e){send(res,409,JSON.stringify({error:e.message}),'application/json')}}else send(res,405,'Method not allowed');return true}
  if(pathname==='/api/catalog'&&req.method==='GET'){send(res,200,JSON.stringify(currentCatalog()),'application/json');return true}
  if(pathname==='/api/style-pricing'&&req.method==='GET'){try{const d=JSON.parse(readFileSync(resolve(process.env.BUSINESS_DATA_DIR||resolve(root,'../data'),'report-review.json'),'utf8'));const rows=d.records.styleMap.map(r=>({style:String(r[0]),sku:String(r[1]),name:String(r[2]),catalog:String(r[3]||''),source:String(r[4]||'')}));send(res,200,JSON.stringify({source:'meesho-style-sku-map_2026-09-27',rows}),'application/json')}catch{send(res,404,'{}','application/json')}return true}
  if(pathname==='/api/catalog-analysis'&&req.method==='GET'){try{const dir=process.env.BUSINESS_DATA_DIR||resolve(root,'../data');const analysis=JSON.parse(readFileSync(resolve(dir,'catalog-analysis.json')));const report=JSON.parse(readFileSync(resolve(dir,'report-review.json')));send(res,200,JSON.stringify(revalueAnalysis(analysis,report,currentCatalog())),'application/json')}catch{send(res,404,'{}','application/json')}return true}
  if(pathname==='/api/report-review'&&req.method==='GET'){try{const d=JSON.parse(readFileSync(resolve(process.env.BUSINESS_DATA_DIR||resolve(root,'../data'),'report-review.json'),'utf8'));delete d.records;send(res,200,JSON.stringify(d),'application/json')}catch{send(res,404,JSON.stringify({error:'Report review not generated'}),'application/json')}return true}
  if(await records(req,res,pathname))return true
  if(pathname==='/health') {send(res,200,JSON.stringify({combo:true,pricing:true}),'application/json');return true}
  if(pathname==='/api/operations') {
    if(req.method==='GET') {send(res,200,JSON.stringify({...readOperations(),catalog:currentCatalog(),lots:catalog.products.flatMap(p=>stockLots(readOperations(),p.id).map(l=>({...l,productId:p.id})))}),'application/json');return true}
    if(req.method!=='POST') {send(res,405,'Method not allowed');return true}
    let body
    try {body=await jsonBody(req)} catch {send(res,400,'Invalid JSON');return true}
    if(!body || !['movement','return'].includes(body.type) || !productIds.has(body.productId) ||
      !Number.isSafeInteger(body.quantity) || body.quantity<1 || body.quantity>100000 ||
      typeof body.note!=='string' || body.note.length>300) {send(res,400,'Invalid entry');return true}
    const data=readOperations()
    const entry={id:randomUUID(),at:new Date().toISOString(),productId:body.productId,quantity:body.quantity,note:body.note.trim()}
    if(body.type==='movement') {
      if(!['received','sold','adjustment'].includes(body.reason) || ![-1,1].includes(body.direction)) {send(res,400,'Invalid movement');return true}
      const onHand=data.movements.filter(x=>x.productId===body.productId).reduce((n,x)=>n+x.quantity*x.direction,0)
      if(onHand+body.quantity*body.direction<0) {send(res,409,'Insufficient stock');return true}
      if((body.reason==='sold'&&body.direction!==-1)||(body.reason==='received'&&body.direction!==1)){send(res,400,'Movement direction conflicts with reason');return true}
      entry.reason=body.reason;entry.direction=body.direction;
      try {
        if(body.direction===1) entry.costPaise=money(body.unitCost);
        else {entry.allocations=allocate(data,body.productId,body.quantity);entry.costPaiseTotal=entry.allocations.reduce((n,a)=>n+a.quantity*a.costPaise,0);}
      } catch(error) {send(res,409,error.message);return true}
      data.movements.push(entry)
    } else {
      if(!['restock','damaged','discarded'].includes(body.disposition) || typeof body.orderId!=='string' ||
        body.orderId.length>100 || typeof body.refund!=='number' || !Number.isFinite(body.refund) ||
        body.refund<0 || body.refund>10000000) {send(res,400,'Invalid return');return true}
      const sale=data.movements.find(m=>m.id===body.saleId&&m.reason==='sold'&&m.productId===body.productId);
      const already=data.returns.filter(r=>r.saleId===body.saleId).reduce((n,r)=>n+r.quantity,0);
      if(!sale?.allocations||already+body.quantity>sale.quantity){send(res,409,'Select an original sale with enough unreturned units');return true}
      try{money(body.refund)}catch(error){send(res,400,error.message);return true}
      entry.saleId=sale.id;
      let skip=already,left=body.quantity;entry.allocations=[];
      for(const a of sale.allocations){const ignored=Math.min(skip,a.quantity);skip-=ignored;const take=Math.min(left,a.quantity-ignored);if(take){entry.allocations.push({...a,quantity:take});left-=take}}
      entry.disposition=body.disposition;entry.orderId=body.orderId.trim();entry.refund=body.refund
      data.returns.push(entry)
      if(body.disposition==='restock') entry.allocations.forEach(a=>data.movements.push({...entry,id:randomUUID(),quantity:a.quantity,costPaise:a.costPaise,reason:'return',direction:1}))
    }
    saveOperations(data);send(res,201,JSON.stringify(entry),'application/json');return true
  }
  if(pathname==='/combo' || pathname.startsWith('/combo/')) {
    if(!['GET','HEAD'].includes(req.method)) {send(res,405,'Method not allowed');return true}
    const suffix=pathname.replace(/^\/combo\/?/,'') || 'index.html'
    const target=resolve(dist,suffix)
    if(target!==dist && !target.startsWith(dist+'/')) {send(res,403,'Forbidden');return true}
    if(!existsSync(target)) {send(res,404,'Not found');return true}
    const ext=target.split('.').pop()
    send(res,200,readFileSync(target),types[ext]||'application/octet-stream');return true
  }
  if(pathname.startsWith('/queue/')) {
    if(!['GET','HEAD'].includes(req.method)) {send(res,405,'Method not allowed');return true}
    const name=pathname.slice(7)
    if(!['panel.html','panel.js','panel.css','icon.png'].includes(name)) {send(res,404,'Not found');return true}
    let body=readFileSync(resolve(extension,name))
    if(name==='panel.html') body=Buffer.from(body.toString().replace('<script src="panel.js">','<script src="/dashboard/queue-adapter.js"></script><script src="panel.js">'))
    if(name==='panel.js') body=Buffer.from(body.toString().replace('const PORTS = [4173, 4174, 4175, 4176, 4177]','const PORTS = [Number(location.port)]').replace('const base = `http://localhost:${port}`','const base = location.origin'))
    send(res,200,body,types[name.split('.').pop()]||'application/octet-stream');return true
  }
  const file=files.get(pathname)
  if(file) {
    if(!['GET','HEAD'].includes(req.method)) {send(res,405,'Method not allowed');return true}
    send(res,200,readFileSync(resolve(root,file)),types[file.split('.').pop()]||'application/octet-stream');return true
  }
  return false
}
