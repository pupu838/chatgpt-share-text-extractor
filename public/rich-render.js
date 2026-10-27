// Shared safe rich-text pipeline: used by both the browser preview and PNG pages.
// No untrusted text is evaluated as code or injected as HTML.
const ICONS={brain:'🧠',headphones:'🎧','book-open':'📖','file-text':'📄',clock:'◷',calendar:'▦',check:'✓','check-circle':'✓',target:'◎',search:'⌕',star:'★',music:'♫',lightbulb:'💡',info:'ⓘ'};
const TAGS=new Set('row box col card grid grid-item list list-item flow flow-item badge text title bold italic underline strikethrough label caption code icon divider spacer blockquote link'.split(' '));
const BLOCKS=new Set('row box col card grid grid-item list list-item flow flow-item blockquote'.split(' '));
const fontFamily='-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';
function attrs(tag){const o={};for(const m of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\})/g))o[m[1]]=m[2]??m[3]??m[4];return o;}
function state(stack){
  const s={};for(const item of stack){
    const n=item.name,a=item.attrs;
    if(n==='badge')s.badge=true;
    if(n==='bold')s.bold=true;
    if(n==='italic')s.italic=true;
    if(n==='underline'||n==='link')s.underline=true;
    if(n==='strikethrough')s.strike=true;
    if(n==='code')s.code=true;
    if(n==='title')s.title=true;
    if(n==='box'||n==='card'||n==='blockquote')s.boxed=true;
    if(['text','label','caption','title'].includes(n)){
      if(['secondary','muted','subtle'].includes(a.color))s.muted=true;
      if(['bold','medium','semibold'].includes(a.weight))s.bold=true;
      if(['xs','sm','small'].includes(a.size))s.small=true;
    }
  }
  return s;
}
function pushRun(runs,text,style={}){
  if(!text)return;
  const last=runs[runs.length-1];
  if(last&&JSON.stringify(last.style)===JSON.stringify(style))last.text+=text;
  else runs.push({text,style:{...style}});
}
function inline(text,style={}){
  const out=[],regex=/(!?\[([^\]]*)\]\([^)]+\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\x60([^\x60]+)\x60|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let from=0,m;while((m=regex.exec(text))){
    pushRun(out,text.slice(from,m.index),style);
    if(m[2]!==undefined)pushRun(out,m[2]||'图片',{...style,underline:!m[1].startsWith('!')});
    else if(m[3]!==undefined||m[4]!==undefined)pushRun(out,m[3]??m[4],{...style,bold:true});
    else if(m[5]!==undefined)pushRun(out,m[5],{...style,strike:true});
    else if(m[6]!==undefined)pushRun(out,m[6],{...style,code:true});
    else pushRun(out,m[7]??m[8],{...style,italic:true});
    from=regex.lastIndex;
  }
  pushRun(out,text.slice(from),style);
  return out;
}
function lineFrom(runs,stack,codeMode=false){
  const st=state(stack),raw=runs.map(r=>r.text).join(''),t=raw.trim();
  if(!t)return {kind:'space',runs:[]};
  if(/^\x60{3}/.test(t))return {kind:'fence',runs:[]};
  if(!codeMode&&/^(?:---+|\*\*\*+|___+)$/.test(t))return {kind:'rule',runs:[]};
  if(!codeMode&&/^\|?[\s|:-]+\|?$/.test(t)&&t.includes('---'))return {kind:'skip',runs:[]};
  let kind=codeMode?'code':'p',value=t,prefix='';
  if(!codeMode){
    const h=t.match(/^(#{1,6})\s+(.+)$/);
    const li=t.match(/^[-*+]\s+(.+)$/);
    const ol=t.match(/^(\d+)[.)]\s+(.+)$/);
    const q=t.match(/^>\s*(.+)$/);
    if(h){kind='h'+h[1].length;value=h[2];}
    else if(li){kind='list';prefix='•  ';value=li[1];}
    else if(ol){kind='list';prefix=ol[1]+'.  ';value=ol[2];}
    else if(q){kind='quote';value=q[1];}
    else if(/^\|.*\|$/.test(t)){
      const cells=t.slice(1,-1).split('|').map(x=>x.trim());
      if(cells.every(c=>/^:?-{3,}:?$/.test(c)))return {kind:'skip',runs:[]};
      return {kind:'table',cells,runs:inline(cells.join('   ·   '),st),...st};
    }
  }
  if(st.title&&kind==='p')kind='h3';
  // Preserve component-level inline styles when there is no markdown block marker.
  const unchanged=kind==='p'&&raw.trim()===value;
  const trimmedRuns=runs.map(r=>({text:r.text,style:r.style}));
  // DSL indentation is source formatting, not intended visual whitespace.
  while(trimmedRuns.length&& !trimmedRuns[0].text.trim())trimmedRuns.shift();
  while(trimmedRuns.length&& !trimmedRuns.at(-1).text.trim())trimmedRuns.pop();
  if(trimmedRuns.length) {
    trimmedRuns[0].text=trimmedRuns[0].text.replace(/^\s+/,'');
    trimmedRuns[trimmedRuns.length-1].text=trimmedRuns.at(-1).text.replace(/\s+$/,'');
  }
  let result=unchanged?trimmedRuns.flatMap(r=>inline(r.text,r.style)):inline(prefix+value,st);
  if(codeMode)result=[{text:t,style:{...st,code:true}}];
  return {kind,runs:result,...st};
}
export function parseRichLines(source){
  const str=String(source??'').replace(/\r\n?/g,'\n'),output=[],stack=[];
  let pending=[],inCode=false;
  function put(line){
    if(line.kind==='fence'){inCode=!inCode;return;}
    if(line.kind==='skip')return;
    if(line.kind==='space'&&(!output.length||output.at(-1).kind==='space'))return;
    output.push(line);
  }
  function flush(blank=false){
    if(pending.some(r=>r.text.trim()))put(lineFrom(pending,stack,inCode));
    else if(blank)put({kind:'space',runs:[]});
    pending=[];
  }
  function add(t){
    const parts=t.split('\n');
    for(let i=0;i<parts.length;i++){
      if(i) {
        const inlineRow=stack.some(x=>x.name==='row') &&
          !stack.some(x=>['box','card','col','grid','list','blockquote'].includes(x.name));
        if(inlineRow&&!inCode&&(parts.length===2||parts[i].trim()))pushRun(pending,' ',state(stack));
        else flush(!parts[i].trim());
      }
      if(parts[i])pushRun(pending,parts[i],state(stack));
    }
  }
  const tagRegex=/<\/?([a-zA-Z][\w-]*)(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  let at=0,m;while((m=tagRegex.exec(str))){
    add(str.slice(at,m.index));at=tagRegex.lastIndex;
    const tag=m[0],name=m[1].toLowerCase();
    if(inCode){add(tag);continue;} // Code fences show source literally.
    if(!TAGS.has(name))continue; // Unknown markup is not executable.
    const closing=tag.startsWith('</'),self=tag.endsWith('/>'),a=attrs(tag);
    if(closing){
      if(BLOCKS.has(name))flush();
      const i=stack.findLastIndex(x=>x.name===name);
      if(i>=0)stack.splice(i);
      if(name==='badge')pushRun(pending,'  ',state(stack));
    }else if(name==='divider'){flush();put({kind:'rule',runs:[]});}
    else if(name==='spacer'){flush();put({kind:'space',runs:[]});}
    else if(name==='icon')pushRun(pending,(ICONS[a.name]||'◆')+' ',{...state(stack),icon:true});
    else if(!self){if(BLOCKS.has(name))flush();stack.push({name,attrs:a});}
  }
  add(str.slice(at));flush();
  while(output.at(-1)?.kind==='space')output.pop();
  return output.length?output:[{kind:'space',runs:[]}];
}
export function renderRichLines(lines,doc=document){
  const frag=doc.createDocumentFragment();let table=null;
  for(const line of lines){
    if(line.kind!=='table')table=null;
    if(line.kind==='table'){
      if(!table){table=doc.createElement('div');table.className='rich-table';frag.appendChild(table);}
      const row=doc.createElement('div');row.className='rich-table-row';
      for(const cell of line.cells||[]){
        const el=doc.createElement('div');el.className='rich-cell';
        for(const r of inline(cell,line))el.appendChild(renderRun(r,doc));
        row.appendChild(el);
      }
      table.appendChild(row);continue;
    }
    const el=doc.createElement('div');
    el.className='rich-line rich-'+line.kind+(line.boxed?' rich-boxed':'');
    if(line.kind==='rule')el.setAttribute('aria-hidden','true');
    for(const run of line.runs)el.appendChild(renderRun(run,doc));
    frag.appendChild(el);
  }
  return frag;
}
function renderRun(run,doc){
  const el=doc.createElement('span'),s=run.style||{};
  el.className='rich-run'+(s.badge?' rich-badge':'')+(s.muted?' rich-muted':'')+(s.code?' rich-code-inline':'')+(s.small?' rich-small':'')+(s.icon?' rich-icon':'');
  if(s.bold)el.style.fontWeight='750';
  if(s.italic)el.style.fontStyle='italic';
  if(s.underline)el.style.textDecoration='underline';
  if(s.strike)el.style.textDecoration='line-through';
  el.textContent=run.text;return el;
}
function font(line,style={}){
  const k=line.kind,size=style.small?22:k==='h1'?38:k==='h2'?34:k==='h3'?31:k==='table'||k==='code'?23:27;
  return {size,font:(style.italic?'italic ':'')+((style.bold||style.badge||k.startsWith('h'))?'700 ':'400 ')+size+'px '+(style.code?'monospace':fontFamily)};
}
function lineHeight(k){return k==='h1'?60:k==='h2'?54:k==='h3'?49:k==='code'?41:k==='table'?42:k==='rule'?29:k==='space'?16:43;}
export function layoutRichLines(ctx,source,width){
  const output=[];
  for(const original of source){
    if(original.kind==='space'||original.kind==='rule'){output.push({...original,height:lineHeight(original.kind)});continue;}
    let current=[],taken=0,continued=false;
    const limit=Math.max(90,width-(original.boxed?24:0)-(original.kind==='quote'?20:0));
    function flush(){if(current.length){output.push({...original,runs:current,height:lineHeight(original.kind),continuation:continued});current=[];taken=0;continued=true;}}
    for(const run of original.runs){
      const st=run.style||{},f=font(original,st);ctx.font=f.font;
      const parts=run.text.match(/\s+|[A-Za-z0-9]+(?:['’._/-][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/gu)||[];
      for(const part of parts){
        ctx.font=f.font;
        if(!current.length&&/^\s+$/.test(part))continue;
        const whole=ctx.measureText(part).width+(st.badge?14:0);
        if(current.length&&taken+whole>limit)flush();
        if(whole<=limit){pushRun(current,part,st);taken+=whole;}
        else for(const ch of [...part]){
          const w=ctx.measureText(ch).width;
          if(current.length&&taken+w>limit)flush();
          pushRun(current,ch,st);taken+=w;
        }
      }
    }
    flush();
  }
  return output;
}
export const heightOfRichLines=lines=>lines.reduce((a,l)=>a+(l.height||lineHeight(l.kind)),0);
export function paintRichLine(ctx,line,x,y,width){
  const h=line.height||lineHeight(line.kind);
  if(line.kind==='space')return;
  ctx.save();
  if(line.kind==='rule'){
    ctx.strokeStyle='#dde3ea';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y+h/2);ctx.lineTo(x+width,y+h/2);ctx.stroke();ctx.restore();return;
  }
  if(line.boxed||['quote','code','table'].includes(line.kind)){
    ctx.fillStyle=line.kind==='code'?'#f2f4f6':line.kind==='quote'?'#eef5fa':line.kind==='table'?'#f6f8fa':'#f3f6f8';
    ctx.fillRect(x,y,width,h);
    if(line.boxed||line.kind==='quote'){ctx.fillStyle='#b8c9d7';ctx.fillRect(x,y,4,h);}
  }
  let at=x+(line.boxed?14:0)+(line.kind==='quote'?12:0)+(line.continuation&&line.kind==='list'?20:0);
  const top=y+Math.max(4,(h-32)/2);
  for(const run of line.runs){
    const st=run.style||{},f=font(line,st);
    ctx.font=f.font;ctx.textBaseline='top';
    const w=ctx.measureText(run.text).width;
    if(st.badge){ctx.fillStyle='#e6eff9';ctx.beginPath();ctx.roundRect(at,top-4,w+16,Math.max(33,f.size+10),10);ctx.fill();at+=8;}
    else if(st.code){ctx.fillStyle='#e8eef3';ctx.fillRect(at,top-1,w+4,f.size+5);}
    ctx.fillStyle=st.muted?'#647386':st.icon?'#12866e':'#15202b';
    ctx.fillText(run.text,at,top);
    if(st.underline||st.strike){
      ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=1;const yp=top+(st.strike?f.size*.5:f.size+2);
      ctx.beginPath();ctx.moveTo(at,yp);ctx.lineTo(at+w,yp);ctx.stroke();
    }
    at+=w+(st.badge?8:0);
  }
  ctx.restore();
}
