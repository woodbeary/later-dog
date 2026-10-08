import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24+ to package later.dog.');
if (process.platform !== 'darwin') throw new Error('This package command currently qualifies macOS only.');
// LATERDOG_MAC_IDENTITY names later.dog's own signing identity (CI loads it from repository secrets); without it the app is
// signed ad hoc, which macOS treats as a new app on every build.
const identity=process.env.LATERDOG_MAC_IDENTITY?.trim();
const environment={...process.env,LATERDOG_LOCAL_PACKAGE:'1',...(identity?{CSC_NAME:identity,CSC_IDENTITY_AUTO_DISCOVERY:'true'}:{CSC_IDENTITY_AUTO_DISCOVERY:'false'})};
const run=(args)=>{ const result=spawnSync('pnpm',args,{stdio:'inherit',env:environment}); if(result.error) throw result.error; return result.status??1; };
for (const args of [['package:prepare'],['laterdog:icons']]) { const status=run(args); if(status!==0) process.exit(status); }
// The dictation helper is Swift. A Mac whose Command Line Tools cannot compile it (a stale SDK, no Xcode) still gets a
// working app: the bundle ships with its Info.plist only and the app reports dictation as unavailable. Release builds go
// through CI's toolchain and use package:mac, which keeps the helper mandatory.
if (run(['build:speech'])!==0) {
  const bundle=join('electron','resources','later.dog Speech.app','Contents');
  mkdirSync(join(bundle,'MacOS'),{recursive:true});
  if(!existsSync(join(bundle,'Info.plist'))) copyFileSync(join('electron','resources','speech-helper-Info.plist'),join(bundle,'Info.plist'));
  console.warn('\nlater.dog: the voice dictation helper could not be compiled on this Mac (swiftc failed above); packaging without it. Everything except dictation works.\n');
}
for (const args of [['build:cua'],['exec','electron-builder','--mac','dir',`--${process.arch}`,'--publish','never']]) { const status=run(args); if(status!==0) process.exit(status); }
console.log(identity?`Built later.dog in release/mac-${process.arch}/later.dog.app, signed as ${identity} (not notarized).`:`Built later.dog in release/mac-${process.arch}/later.dog.app, signed ad hoc (not notarized).`);
