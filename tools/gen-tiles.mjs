// Generate a tiled OSM building/tree dataset (global tile grid) for several cities.
// Resumable: skips tiles already on disk. Each tile ~3 km; the app lazy-loads only the
// tiles it needs. node gen-tiles.mjs <outdir>
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
const OUTDIR = process.argv[2];
mkdirSync(OUTDIR, { recursive: true });

const TLAT = 0.027, TLON = 0.04;     // ~3.0 km lat, ~3.0 km lon — MUST match the app
const RING = 3;                       // ±3 tiles → 7×7 grid ≈ ±9 km coverage per city
const CITIES = [
  { name: 'karlsruhe', lat: 49.00937, lon: 8.40444 },
  { name: 'paris',     lat: 48.85660, lon: 2.35220 },
  { name: 'munich',    lat: 48.13740, lon: 11.57550 },
  { name: 'cologne',   lat: 50.94130, lon: 6.95830 },
  { name: 'stuttgart', lat: 48.77580, lon: 9.18290 },
];
const EPS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function bh(t){t=t||{};
  if(t.height){const h=parseFloat(String(t.height).replace(',','.'));if(isFinite(h)&&h>0)return h;}
  if(t['building:levels']){const lv=parseFloat(String(t['building:levels']).replace(',','.'));if(isFinite(lv)&&lv>0)return lv*3.2+1;}
  const b=t.building;
  if(b==='church'||b==='cathedral')return 20; if(b==='commercial'||b==='retail'||b==='office')return 12;
  if(b==='apartments')return 15; if(b==='house'||b==='detached'||b==='garage'||b==='hut'||b==='shed')return 6;
  return 9;}
function tp(t){t=t||{};
  let height=9,h;
  if(t.height){h=parseFloat(String(t.height).replace(',','.'));if(isFinite(h)&&h>0)height=h;}
  else if(t.est_height){h=parseFloat(String(t.est_height).replace(',','.'));if(isFinite(h)&&h>0)height=h;}
  let crownR=3.5;
  if(t.diameter_crown){const d=parseFloat(String(t.diameter_crown).replace(',','.'));if(isFinite(d)&&d>0)crownR=d/2;}
  else crownR=Math.max(2,height*0.35);
  const lt=t.leaf_type, evg=lt==='needleleaved'||t.leaf_cycle==='evergreen';
  return {height,crownR,base:lt==='needleleaved'?0.85:0.7,evg:evg?1:0};}
const r6=x=>Math.round(x*1e6)/1e6, r1=x=>Math.round(x*10)/10;

async function fetchTile(s,w,n,e){
  const q=`[out:json][timeout:90];(way["building"](${s},${w},${n},${e});relation["building"]["type"="multipolygon"](${s},${w},${n},${e}););out geom;node["natural"="tree"](${s},${w},${n},${e});out;`;
  for(let attempt=0; attempt<3; attempt++){
    for(const u of EPS){
      try{
        const res=await fetch(u,{method:'POST',body:'data='+encodeURIComponent(q),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
        const txt=await res.text();
        if(!res.ok) throw new Error('http '+res.status);
        const j=JSON.parse(txt);
        if(!j.elements) throw new Error('no elements');
        return j;
      }catch(err){ await sleep(700); }
    }
    await sleep(2500*(attempt+1));
  }
  return null;
}
function parse(j){
  const b=[], t=[];
  for(const el of j.elements){
    if(el.type==='way'&&el.geometry&&el.tags&&(el.tags.building||el.tags['building:part'])){
      const ring=el.geometry.filter(g=>g&&g.lat!=null).map(g=>[r6(g.lat),r6(g.lon)]);
      if(ring.length>=3) b.push([Math.round(bh(el.tags)),...ring.flat()]);
    } else if(el.type==='relation'&&el.members){
      const h=Math.round(bh(el.tags));
      for(const m of el.members){ if(m.role==='outer'&&m.geometry){ const ring=m.geometry.filter(g=>g&&g.lat!=null).map(g=>[r6(g.lat),r6(g.lon)]); if(ring.length>=3) b.push([h,...ring.flat()]); } }
    } else if(el.type==='node'&&el.tags&&el.tags.natural==='tree'){
      const p=tp(el.tags); t.push([r6(el.lat),r6(el.lon),r1(p.height),r1(p.crownR),p.base,p.evg]);
    }
  }
  return {b,t};
}
(async()=>{
  const seen=new Set(); let done=0, wrote=0, fail=0;
  const tasks=[];
  for(const c of CITIES){
    const cLa=Math.floor(c.lat/TLAT), cLo=Math.floor(c.lon/TLON);
    for(let la=cLa-RING; la<=cLa+RING; la++) for(let lo=cLo-RING; lo<=cLo+RING; lo++){
      const key=la+'_'+lo; if(seen.has(key)) continue; seen.add(key); tasks.push([la,lo]);
    }
  }
  console.error('tiles to consider:',tasks.length);
  for(const [la,lo] of tasks){
    const fn=OUTDIR+'/t_'+la+'_'+lo+'.json';
    if(existsSync(fn)){ done++; continue; }
    const s=r6(la*TLAT), n=r6((la+1)*TLAT), w=r6(lo*TLON), e=r6((lo+1)*TLON);
    const j=await fetchTile(s,w,n,e);
    if(!j){ fail++; console.error('FAIL',la,lo); await sleep(1500); continue; }
    const {b,t}=parse(j);
    writeFileSync(fn, JSON.stringify({v:1,bbox:[s,w,n,e],b,t}));
    wrote++; done++; console.error('wrote',la+'_'+lo,'b',b.length,'t',t.length,`(${done}/${tasks.length})`);
    await sleep(1100);
  }
  console.error('DONE wrote',wrote,'fail',fail);
})();
