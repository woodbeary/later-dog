import fs from "node:fs";import path from "node:path";import {execSync} from "node:child_process";import {createRequire} from "node:module";
const [root,scopeRe,tsFrom,outFile]=process.argv.slice(2);
const ts=createRequire(tsFrom)("typescript");
process.chdir(root);
const files=execSync("git ls-files",{maxBuffer:1e9}).toString().split("\n").filter(f=>/\.(tsx?|mjs|cjs|js|mts)$/.test(f));
const texts=new Map(files.map(f=>[f,fs.readFileSync(f,"utf8")]));
const isTest=f=>/(^|\/)(test|tests)\/|\.test\.|\.node-test\./.test(f);
const scope=new RegExp(scopeRe);
const words=new Map();
for(const [f,t] of texts){const c=new Map();for(const m of t.matchAll(/[A-Za-z_$][\w$]*/g)) c.set(m[0],(c.get(m[0])||0)+1);words.set(f,c);}
const out=[];
for(const f of files){ if(!scope.test(f)||!/\.(tsx?)$/.test(f)||f.endsWith(".d.ts")) continue;
  const src=texts.get(f);const sf=ts.createSourceFile(f,src,ts.ScriptTarget.Latest,true,f.endsWith("x")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  for(const st of sf.statements){
    const exp=ts.canHaveModifiers(st)&&ts.getModifiers(st)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
    if(!exp) continue;
    if(ts.getModifiers(st).some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)) continue;
    const names=[];let kind="";
    if(ts.isFunctionDeclaration(st)&&st.name){names.push(st.name.text);kind="function"}
    else if(ts.isClassDeclaration(st)&&st.name){names.push(st.name.text);kind="class"}
    else if(ts.isVariableStatement(st)){for(const d of st.declarationList.declarations) if(ts.isIdentifier(d.name)) names.push(d.name.text);kind="const"}
    else if(ts.isEnumDeclaration(st)){names.push(st.name.text);kind="enum"}
    else continue;
    const lines=sf.getLineAndCharacterOfPosition(st.end).line-sf.getLineAndCharacterOfPosition(st.getStart()).line+1;
    for(const n of names){
      let own=words.get(f).get(n)||0, ext=0, extTest=0;
      for(const [g,c] of words){ if(g===f) continue; const k=c.get(n)||0; if(!k) continue; if(isTest(g)) extTest+=k; else ext+=k; }
      if(ext===0){ out.push([f,kind,n,Math.round(lines/names.length),own>1?"used-in-file":"no-ref-in-file",extTest>0?"test-only("+extTest+")":"no-test-ref"]); }
    }
  }
}
fs.writeFileSync(outFile,out.map(o=>o.join("\t")).join("\n"));
console.log(out.length);
