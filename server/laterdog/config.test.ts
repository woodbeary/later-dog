import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './command.ts';
import { desktopSupervisorToken, supervisorConnection, supervisorOrigin, supervisorToken } from './config.ts';
it('initializes one private token when desktop and supervisor start concurrently',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'laterdog-token-')); const file=fileURLToPath(new URL('./config.ts',import.meta.url));
 vi.stubEnv('LATERDOG_TOKEN','');vi.stubEnv('LATERDOG_TOKEN_FILE','');delete process.env.LATERDOG_TOKEN_FILE;
 try {
   const results=await Promise.all(Array.from({length:3},()=>runCommand(process.execPath,['--input-type=module','-e',`import {supervisorToken} from ${JSON.stringify(file)}; process.stdout.write(supervisorToken(${JSON.stringify(dir)}));`],{timeoutMs:60_000})));
   expect(results.every(result=>result.exitCode===0)).toBe(true);expect(new Set(results.map(result=>result.stdout)).size).toBe(1);expect(results[0].stdout.length).toBeGreaterThanOrEqual(32);
   expect(supervisorToken(dir)).toBe(results[0].stdout);expect(statSync(join(dir,'access-token')).mode&0o777).toBe(0o600);
 } finally {vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
});
it('trims a token supplied through the environment so a pasted trailing newline cannot cause 401s',()=>{
 vi.stubEnv('LATERDOG_TOKEN',`${'x'.repeat(40)}\n`);
 try {expect(supervisorToken('/nonexistent/laterdog')).toBe('x'.repeat(40));} finally {vi.unstubAllEnvs();}
});
it('finds a hosted supervisor through the saved connection file, with the environment winning and the local supervisor as the default',()=>{
 const dir=mkdtempSync(join(tmpdir(),'laterdog-connection-'));
 for(const name of ['LATERDOG_SUPERVISOR_URL','LATERDOG_TOKEN_FILE','LATERDOG_TOKEN'])vi.stubEnv(name,'');
 for(const name of ['LATERDOG_SUPERVISOR_URL','LATERDOG_TOKEN_FILE','LATERDOG_TOKEN'])delete process.env[name];
 vi.stubEnv('LATERDOG_HOME',dir);
 try {
   expect(supervisorConnection()).toEqual({origin:'http://127.0.0.1:9010',source:'local'});
   const tokenFile=join(dir,'hosted-token');writeFileSync(tokenFile,`${'t'.repeat(43)}\n`,{mode:0o600});
   writeFileSync(join(dir,'supervisor.json'),JSON.stringify({url:'https://supervisor.example.test/',tokenFile}));
   expect(supervisorConnection()).toEqual({origin:'https://supervisor.example.test',tokenFile,source:'file'});
   expect(supervisorOrigin()).toBe('https://supervisor.example.test');expect(desktopSupervisorToken()).toBe('t'.repeat(43));
   // A hosted connection whose token file is gone must not fall back to minting a local token that would only 401.
   writeFileSync(join(dir,'supervisor.json'),JSON.stringify({url:'https://supervisor.example.test',tokenFile:join(dir,'missing')}));
   expect(()=>desktopSupervisorToken()).toThrow(/does not exist/);
   writeFileSync(join(dir,'supervisor.json'),JSON.stringify({url:'http://supervisor.example.test',tokenFile}));
   expect(()=>supervisorConnection()).toThrow(/HTTPS/);
   vi.stubEnv('LATERDOG_SUPERVISOR_URL','https://other.example.test');vi.stubEnv('LATERDOG_TOKEN_FILE',tokenFile);
   expect(supervisorConnection()).toEqual({origin:'https://other.example.test',tokenFile,source:'environment'});
   vi.stubEnv('LATERDOG_TOKEN','e'.repeat(40));expect(desktopSupervisorToken()).toBe('e'.repeat(40));
 } finally {vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
});
