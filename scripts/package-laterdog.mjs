import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageFeedArguments } from './laterdog-release-files.mjs';
import { describeVariant, resolveVariantId } from '../electron/app-variant.mjs';
import { builderArguments } from './laterdog-dev-build.mjs';
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24+ to package later.dog.');
if (process.platform !== 'darwin') throw new Error('This package command currently qualifies macOS only.');
const identity=process.env.LATERDOG_MAC_IDENTITY?.trim();
const variantId=resolveVariantId();
const variant=describeVariant(variantId);
const feedArguments=packageFeedArguments({identity,feed:process.env.LATERDOG_UPDATE_FEED});
const variantArguments=builderArguments(variantId,{version:process.env.LATERDOG_DEV_VERSION});
const environment={...process.env,LATERDOG_LOCAL_PACKAGE:'1',...(identity?{CSC_NAME:identity,CSC_IDENTITY_AUTO_DISCOVERY:'true'}:{CSC_IDENTITY_AUTO_DISCOVERY:'false'})};
const run=(args)=>{ const result=spawnSync('pnpm',args,{stdio:'inherit',env:environment}); if(result.error) throw result.error; return result.status??1; };
for (const args of variantId==='dev'?[['package:prepare']]:[['package:prepare'],['laterdog:icons']]) { const status=run(args); if(status!==0) process.exit(status); }
if (run(['build:speech'])!==0) {
  const bundle=join('electron','resources','later.dog Speech.app','Contents');
  mkdirSync(join(bundle,'MacOS'),{recursive:true});
  if(!existsSync(join(bundle,'Info.plist'))) copyFileSync(join('electron','resources','speech-helper-Info.plist'),join(bundle,'Info.plist'));
  console.warn('\nlater.dog: the voice dictation helper could not be compiled on this Mac (swiftc failed above); packaging without it. Everything except dictation works.\n');
}
for (const args of [['build:cua'],['exec','electron-builder','--mac','dir',`--${process.arch}`,'--publish','never',...feedArguments,...variantArguments]]) { const status=run(args); if(status!==0) process.exit(status); }
console.log(identity?`Built later.dog in release/mac-${process.arch}/${variant.productName}.app, signed as ${identity} (not notarized)${feedArguments.length?', updating itself from '+process.env.LATERDOG_UPDATE_FEED.trim():''}.`:`Built later.dog in release/mac-${process.arch}/${variant.productName}.app, signed ad hoc (not notarized).`);
