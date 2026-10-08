import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permittedRoot, inspectRepository } from './bridge.ts';
import { runCommand, requireSuccess } from './command.ts';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
it('returns bounded repository metadata without reading credential files and refuses symlink escapes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'laterdog-bridge-'));dirs.push(dir);const repo=join(dir,'repo');mkdirSync(repo);
 requireSuccess(await runCommand('git',['init','-b','main'],{cwd:repo}),'Fixture Git');
 writeFileSync(join(repo,'package.json'),JSON.stringify({name:'fixture',packageManager:'pnpm@10.33.0'}));writeFileSync(join(repo,'.env'),'SECRET_DO_NOT_READ=private-fixture-value');
 const metadata=JSON.stringify(await inspectRepository(repo,[repo]));expect(metadata).toContain('fixture');expect(metadata).not.toContain('private-fixture-value');
 const outside=join(dir,'outside');mkdirSync(outside);symlinkSync(outside,join(repo,'escape'));expect(()=>permittedRoot(join(repo,'escape'),[repo])).toThrow(/escapes/);
});
