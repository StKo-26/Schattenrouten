/* ShadeWalk navigation core — pure geo/route/shade/maneuver helpers.
   Exposes window.NavCore. No framework, no DOM. */
(function(){
  const R = 6371000, D = Math.PI/180;
  const CENTER = [49.00937, 8.40444];

  function hav(a, b){
    const dLat=(b[0]-a[0])*D, dLng=(b[1]-a[1])*D, la1=a[0]*D, la2=b[0]*D;
    const x=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(x));
  }
  function bearing(a, b){
    const y=Math.sin((b[1]-a[1])*D)*Math.cos(b[0]*D);
    const x=Math.cos(a[0]*D)*Math.sin(b[0]*D)-Math.sin(a[0]*D)*Math.cos(b[0]*D)*Math.cos((b[1]-a[1])*D);
    return (Math.atan2(y,x)/D+360)%360;
  }
  function hash(a,b){let s=Math.sin(a*127.1+b*311.7)*43758.5453;return s-Math.floor(s);}
  function hash2(a,b){let s=Math.sin(a*269.5+b*183.3)*54321.123;return s-Math.floor(s);}
  function sunElev(h){const t=(h-6)/12;return h<=6||h>=18?0:Math.max(0,Math.sin(Math.PI*t));}
  function sunAz(h){const c=Math.max(6,Math.min(18,h));return 90+(c-6)/12*180;}

  function shadeAt(lat,lng,h,bias){
    const elev=sunElev(h);
    if(elev<=0.02) return 0.93;
    const d=hav([lat,lng],CENTER)/1000;
    const built=Math.max(0.08,Math.min(1,1-d/3));
    const low=1-elev;
    const orient=hash(lat*1.7,lng*1.3);
    const tree=hash2(lat,lng);
    let s=0.16+0.5*built*(0.32+0.68*low)+0.26*tree*(0.4+0.6*low)+0.16*orient+(bias||0);
    return Math.max(0.03,Math.min(0.98,s));
  }

  function cumulative(coords){
    const cum=[0];
    for(let i=1;i<coords.length;i++) cum.push(cum[i-1]+hav(coords[i-1],coords[i]));
    return cum;
  }
  // interpolate a point at distance d (metres) along the path
  function pointAt(coords,cum,d){
    const total=cum[cum.length-1]; d=Math.max(0,Math.min(total,d));
    let i=1; while(i<cum.length && cum[i]<d) i++; if(i>=cum.length) i=cum.length-1;
    const seg=(cum[i]-cum[i-1])||1; const t=(d-cum[i-1])/seg;
    const a=coords[i-1], b=coords[i];
    return {lat:a[0]+(b[0]-a[0])*t, lng:a[1]+(b[1]-a[1])*t, seg:i-1, t};
  }
  function toXY(p,ref){return [(p[1]-ref[1])*D*Math.cos(ref[0]*D)*R, (p[0]-ref[0])*D*R];}
  // nearest point on path to p -> {along (metres from start), pt:[lat,lng], off (metres off route)}
  function projectOnPath(p,coords,cum){
    const ref=coords[0]; const P=toXY(p,ref);
    let best={off:1e9, along:0, pt:coords[0]};
    for(let i=1;i<coords.length;i++){
      const A=toXY(coords[i-1],ref), B=toXY(coords[i],ref);
      const dx=B[0]-A[0], dy=B[1]-A[1]; const len2=dx*dx+dy*dy||1;
      let t=((P[0]-A[0])*dx+(P[1]-A[1])*dy)/len2; t=Math.max(0,Math.min(1,t));
      const cx=A[0]+dx*t, cy=A[1]+dy*t; const off=Math.hypot(P[0]-cx,P[1]-cy);
      if(off<best.off){
        const a=coords[i-1], b=coords[i];
        best={off, along:cum[i-1]+(cum[i]-cum[i-1])*t, pt:[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]};
      }
    }
    return best;
  }

  function buildManeuvers(steps){
    const mans=[]; let cum=0;
    (steps||[]).forEach((st)=>{
      const m=st.maneuver||{};
      mans.push({atDist:cum, type:m.type||'continue', modifier:m.modifier||'', name:st.name||''});
      cum+=st.distance||0;
    });
    return mans;
  }

  async function fetchRoutes(a,b){
    const url=`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${a[1]},${a[0]};${b[1]},${b[0]}?alternatives=3&overview=full&geometries=geojson&steps=true`;
    const ctrl=new AbortController(); const tm=setTimeout(()=>ctrl.abort(),7000);
    try{
      const res=await fetch(url,{signal:ctrl.signal}); clearTimeout(tm);
      const j=await res.json();
      if(j.code!=='Ok'||!j.routes||!j.routes.length) return null;
      return j.routes.map(rt=>({
        coords:rt.geometry.coordinates.map(c=>[c[1],c[0]]),
        dist:rt.distance,
        steps:(rt.legs&&rt.legs[0]&&rt.legs[0].steps)||[]
      }));
    }catch(e){ clearTimeout(tm); return null; }
  }

  // synthesized fallback route + maneuvers derived from bearing changes
  function synth(a,b){
    const n=14; const pts=[[a[0],a[1]]];
    const dx=b[0]-a[0], dy=b[1]-a[1]; const perpx=-dy, perpy=dx;
    for(let i=1;i<n;i++){
      const t=i/n; const bend=Math.sin(t*Math.PI)*0.4; const stair=(i%2?1:-1)*0.0004;
      pts.push([a[0]+dx*t+perpx*bend+stair+(hash(i,t)-0.5)*0.0006, a[1]+dy*t+perpy*bend+(hash2(i,t)-0.5)*0.0006]);
    }
    pts.push([b[0],b[1]]);
    const cum=cumulative(pts);
    const mans=[{atDist:0,type:'depart',modifier:'',name:''}];
    for(let i=1;i<pts.length-1;i++){
      const b1=bearing(pts[i-1],pts[i]), b2=bearing(pts[i],pts[i+1]);
      let dd=((b2-b1+540)%360)-180;
      if(Math.abs(dd)>26) mans.push({atDist:cum[i],type:'turn',modifier:dd>0?'right':'left',name:'the path'});
    }
    mans.push({atDist:cum[cum.length-1],type:'arrive',modifier:'',name:''});
    return {coords:pts, dist:cum[cum.length-1], maneuvers:mans, shadeFrac:0.5};
  }

  // enrich + pick shadiest by utility (matches main app weighting)
  function chooseShadiest(routes,hour,weight){
    let best=null, bestU=-1; const w=(weight==null?0.7:weight/100);
    routes.forEach(rt=>{
      const cum=cumulative(rt.coords); let tot=0, sh=0;
      for(let i=1;i<rt.coords.length;i++){
        const len=cum[i]-cum[i-1];
        const m=[(rt.coords[i-1][0]+rt.coords[i][0])/2,(rt.coords[i-1][1]+rt.coords[i][1])/2];
        sh+=shadeAt(m[0],m[1],hour)*len; tot+=len;
      }
      rt.shadeFrac=tot?sh/tot:0.4; rt.len=tot;
      const u=w*rt.shadeFrac+(1-w)*(1-Math.min(1,rt.len/3000));
      if(u>bestU){ bestU=u; best=rt; }
    });
    return best;
  }

  // human-readable instruction + arrow glyph for a maneuver
  function instr(m){
    if(!m) return {t:'Weiter', s:'der Route folgen', ic:'↑'};
    const name=(m.name&&m.name!=='')?(' auf '+m.name):'';
    const mod=m.modifier||'';
    if(m.type==='depart') return {t:'Losgehen', s:(m.name?('auf '+m.name):'der Route folgen'), ic:'↑'};
    if(m.type==='arrive') return {t:'Ziel erreicht', s:'angekommen', ic:'◉'};
    if(m.type==='roundabout'||m.type==='rotary') return {t:'In den Kreisverkehr', s:('weiter'+name), ic:'↻'};
    let t='Weiter', ic='↑';
    if(mod.indexOf('left')>=0){ t = mod.indexOf('slight')>=0?'Leicht links':(mod.indexOf('sharp')>=0?'Scharf links':'Links abbiegen'); ic = mod.indexOf('slight')>=0?'↖':'↰'; }
    else if(mod.indexOf('right')>=0){ t = mod.indexOf('slight')>=0?'Leicht rechts':(mod.indexOf('sharp')>=0?'Scharf rechts':'Rechts abbiegen'); ic = mod.indexOf('slight')>=0?'↗':'↱'; }
    else if(mod.indexOf('uturn')>=0){ t='Wenden'; ic='↶'; }
    else { t='Geradeaus'; ic='↑'; }
    return {t, s:('weiter'+name), ic};
  }

  function fmtDist(m){
    if(m<10) return 'Jetzt';
    if(m<1000) return Math.round(m/10)*10+' m';
    return (m/1000).toFixed(1).replace('.',',')+' km';
  }

  window.NavCore={hav,bearing,hash,hash2,sunElev,sunAz,shadeAt,cumulative,pointAt,projectOnPath,toXY,buildManeuvers,fetchRoutes,synth,chooseShadiest,instr,fmtDist,CENTER};
})();
