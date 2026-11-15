import fs from "node:fs";import path from "node:path";import {execSync} from "node:child_process";
const [root,mode,entriesJson,outFile]=process.argv.slice(2);
process.chdir(root);
const files=execSync("git ls-files",{maxBuffer:1e9}).toString().split("\n").filter(f=>/\.(tsx?|mjs|cjs|js|jsx|mts|cts)$/.test(f)&&!f.endsWith(".d.ts")||f.endsWith(".d.ts"));
const set=new Set(files);
const exts=["",".ts",".tsx",".js",".jsx",".mjs",".cjs",".mts",".cts",".ios.tsx",".ios.ts",".native.tsx",".native.ts",".web.tsx",".web.ts",".android.tsx"];
function resolve(from,spec){
  let base;
  if(spec.startsWith("@/")) base="src/"+spec.slice(2);
  else if(spec.startsWith(".")) base=path.posix.join(path.posix.dirname(from),spec);
  else return [];
  const res=[];
  const cands=[base];
  if(/\.(js|mjs|cjs)$/.test(base)) cands.push(base.replace(/\.(js|mjs|cjs)$/,".ts"),base.replace(/\.(js|mjs|cjs)$/,".tsx"),base.replace(/\.js$/,".mts"));
  for(const c of cands){for(const e of exts){ if(set.has(c+e)) res.push(c+e); if(set.has(c+"/index"+e)) res.push(c+"/index"+e);} }
  return res;
}
const re=/(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|["']((?:\.{1,2}\/|@\/)[^"']+)["']/g;
const graph=new Map();const typeOnly=new Map();
for(const f of files){ if(!/\.(tsx?|mjs|cjs|js|jsx|mts|cts)$/.test(f)) continue;
  let s;try{s=fs.readFileSync(f,"utf8")}catch{continue}
  const deps=new Set();
  for(const m of s.matchAll(re)){const spec=m[1]||m[2]||m[3]||m[4];for(const r of resolve(f,spec)) deps.add(r);}
  graph.set(f,deps);}
const entryRes=JSON.parse(entriesJson).map(g=>new RegExp(g));
const seen=new Set();const stack=files.filter(f=>entryRes.some(r=>r.test(f)));
for(const e of stack) seen.add(e);
while(stack.length){const f=stack.pop();for(const d of graph.get(f)||[]) if(!seen.has(d)){seen.add(d);stack.push(d);}}
const importers=new Map();for(const [f,ds] of graph) for(const d of ds){ if(!importers.has(d)) importers.set(d,new Set()); importers.get(d).add(f);}
const dead=[...graph.keys()].filter(f=>!seen.has(f));
fs.writeFileSync(outFile,dead.map(f=>f+"\t"+fs.readFileSync(f,"utf8").split("\n").length+"\t"+[...(importers.get(f)||[])].join(",")).join("\n"));
console.log(graph.size,seen.size,dead.length);
