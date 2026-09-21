import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { startJob, collectJob, reconcileJobs, jobAlive, stopJobs } from '../dist/loop/jobs.js';
import { startPane, launchRun } from '../dist/loop/host.js';
import { createRun, initializeRun, approveRun, readRun } from '../dist/loop/state.js';
import { processSignature } from '../dist/loop/ownership.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, limit = 5000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { if (fn()) return; await sleep(25); }
  assert.fail('Timed out waiting for fixture subprocess');
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wan-host-test-'));
  t.after(async () => { await stopJobs(reconcileJobs(dir, [])); rmSync(dir, {recursive:true, force:true}); });
  return dir;
}
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function initialize(dir) {
  const s = createRun({cwd:dir, plan:{goal:'Fixture only', budgetMs:100000, permissions:[], criteria:[{id:'ok',description:'Fixture',verification:'Fixture'}], deliverables:['Fixture'], verificationCommands:[], tasks:[{id:'fixture',title:'Fixture',instructions:'Fixture only',ownership:['fixture.txt'],criteria:['ok'],dependsOn:[],status:'pending',attempts:0,failures:0}]}});
  approveRun(s);
  initializeRun(dir, {...s,jobs:[], settings:{monitorMs:1000,keepAwake:false}, questions:[],answers:{},failedProviders:{}});
}

test('process birth identity is available, not silently skipped', () => {
  assert.ok(processSignature(process.pid), 'ps permission is required to verify process ownership');
});

test('monitor inspects health at startup but waits one interval before agent supervision', async t => {
  const dir = fixture(t); initialize(dir);
  const { withRun } = await import('../dist/loop/state.js');
  withRun(dir, s => { s.host = { pid: process.pid, signature: processSignature(process.pid), heartbeat: Date.now() }; s.settings.monitorMs = 600000; });
  const marker = join(dir, 'assessment-called');
  const module = new URL('../dist/loop/host.js', import.meta.url).href;
  const code = `import {monitor} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; await monitor(${JSON.stringify(dir)}, {assess: async () => {writeFileSync(${JSON.stringify(marker)}, 'called');}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
  const exited = once(child, 'exit');
  try {
    await until(() => readRun(dir).supervisor.lastInspection !== undefined);
    await sleep(150);
    assert.equal(existsSync(marker), false, 'Startup consumed an agent turn before the first supervision interval');
  } finally { child.kill('SIGTERM'); await exited; }
});

test('two independent controllers execute one durable job and reconciliation merges missing jobs', async t => {
  const dir = fixture(t);
  const command = 'echo ran >> executions; sleep 0.2; echo retained';
  const module = new URL('../dist/loop/jobs.js', import.meta.url).href;
  const code = `import {startJob} from ${JSON.stringify(module)}; startJob(${JSON.stringify(dir)}, ${JSON.stringify(dir)}, ${JSON.stringify(command)}, 'candidate');`;
  const children = [0,1].map(() => spawn(process.execPath, ['--input-type=module','-e',code], {stdio:'inherit'}));
  await Promise.all(children.map(async child => { const [code] = await once(child,'exit'); assert.equal(code,0); }));
  await until(() => reconcileJobs(dir, []).some(j => j.endedAt));
  const jobs = reconcileJobs(dir, []);
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].exitCode,0);
  assert.equal(readFileSync(join(dir,'executions'),'utf8'),'ran\n');
  assert.match(readFileSync(join(jobs[0].directory,'output.log'),'utf8'),/retained/);
  const again = startJob(dir,dir,command,'candidate');
  assert.equal(again.id,jobs[0].id);
  const next = startJob(dir,dir,'echo second','other',1);
  assert.equal(reconcileJobs(dir,[jobs[0],next]).length,2);
});

test('intent without spawned wrapper remains recoverable, grace avoids false failure', async t => {
  const dir = fixture(t);
  // Capture a valid intent shape, then construct an unstarted independent generation.
  const { createHash } = await import('node:crypto');
  const command = 'echo recovered >> executions';
  const id = createHash('sha256').update(JSON.stringify(['candidate',command,0,dir,'test',null])).digest('hex');
  const directory = join(dir,'jobs',id); mkdirSync(directory,{recursive:true});
  const intent = {kind:'test',id,directory,command,candidate:'candidate',generation:0,cwd:dir,pid:0,startedAt:Date.now()-10000};
  writeFileSync(join(directory,'intent.json'),JSON.stringify(intent));
  assert.equal(collectJob(intent).endedAt,undefined);
  assert.equal(reconcileJobs(dir,[]).length,1);
  const job = startJob(dir,dir,command,'candidate');
  startJob(dir,dir,command,'candidate');
  await until(() => collectJob(job).endedAt);
  assert.equal(collectJob(job).exitCode,0);
  assert.equal(readFileSync(join(dir,'executions'),'utf8'),'recovered\n');
});

test('stop cancels an unstarted intent without executing its command', async t => {
  const dir = fixture(t);
  const { createHash } = await import('node:crypto');
  const command = 'echo unwanted > executions';
  const id = createHash('sha256').update(JSON.stringify(['candidate',command,0,dir,'test',null])).digest('hex');
  const directory=join(dir,'jobs',id); mkdirSync(directory,{recursive:true});
  const intent={kind:'test',id,directory,command,candidate:'candidate',cwd:dir,pid:0,startedAt:Date.now()};
  writeFileSync(join(directory,'intent.json'),JSON.stringify(intent));
  await stopJobs([intent]);
  assert.equal(startJob(dir,dir,command,'candidate').exitCode,1);
  assert.equal(existsSync(join(dir,'executions')),false);
});

test('stop kills authenticated descendants even after wrapper exits and result exists', async t => {
  const dir=fixture(t);
  writeFileSync(join(dir,'descendant.cjs'), `require('node:fs').writeFileSync('descendant.pid',String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
  writeFileSync(join(dir,'parent.cjs'), `const c=require('node:child_process').spawn(process.execPath,['descendant.cjs'],{stdio:'ignore'}); c.unref(); setTimeout(()=>process.exit(0),400);`);
  const job=startJob(dir,dir,`${quote(process.execPath)} parent.cjs`,'candidate');
  await until(()=>collectJob(job).endedAt && existsSync(join(dir,'descendant.pid')));
  const descendant=Number(readFileSync(join(dir,'descendant.pid'),'utf8'));
  const owner=JSON.parse(readFileSync(join(job.directory,'owner.json'),'utf8'));
  await until(()=>!processSignature(owner.pid));
  assert.equal(jobAlive(job),true);
  await stopJobs([collectJob(job)]);
  await until(()=> {
    try { return !execFileSync('ps',['-p',String(descendant),'-o','stat='],{encoding:'utf8'}).trim().match(/^[^Z]/); }
    catch { return true; }
  });
});

test('shared launch lease serializes startup; live claimed pane is pending registration', async t => {
  const dir=fixture(t); initialize(dir);
  let live=false, starts=0;
  const boundary={alive:async()=>live,command:async()=>({code:0,stdout:'0',stderr:''}),start:async()=>{ starts++; await sleep(50); live=true; }};
  const results=await Promise.all([startPane(dir,'wan-fixture','_controller',boundary),startPane(dir,'wan-fixture','_controller',boundary)]);
  assert.deepEqual(results,['started','pending']); assert.equal(starts,1);
  assert.equal(existsSync(join(dir,'controller-launch.lease')),false);
});

test('confirmed dead pane respawns with append logging; unclaimed live pane is preserved', async t => {
  const dir=fixture(t); initialize(dir);
  writeFileSync(join(dir,'controller.log'),'old logs');
  const calls=[];
  const boundary={alive:async()=>true,start:async()=>assert.fail('must respawn'),command:async(_cmd,args)=>{calls.push(args); return {code:0,stdout:args[0]==='display-message'?'1':'',stderr:''};}};
  assert.equal(await startPane(dir,'wan-fixture','_controller',boundary),'started');
  assert.match(calls[1].at(-1),/ >> /);
  assert.equal(readFileSync(join(dir,'controller.log'),'utf8'),'old logs');
  rmSync(join(dir,'controller-starting.json'));
  boundary.command=async()=>({code:0,stdout:'0',stderr:''});
  await assert.rejects(startPane(dir,'wan-fixture','_controller',boundary),/preserved/);
});

test('stalled live launch is diagnosed without killing or respawning pane', async t => {
  const dir=fixture(t); initialize(dir);
  writeFileSync(join(dir,'controller-starting.json'),JSON.stringify({name:'wan-fixture',startedAt:Date.now()-61000}));
  const boundary={alive:async()=>true,start:async()=>assert.fail('must preserve'),command:async()=>({code:0,stdout:'0',stderr:''})};
  await assert.rejects(startPane(dir,'wan-fixture','_controller',boundary),/not registered/);
});


test('startup timeout journals no useful work before diagnosis and reports failure', async t => {
  const dir=fixture(t); initialize(dir);
  let diagnosed=false;
  const boundary={alive:async()=>false,start:async()=>{},command:async()=>({code:0,stdout:'',stderr:''})};
  await assert.rejects(launchRun(dir,true,{commands:boundary,startupMs:0,assess:async()=>{
    assert.equal(readRun(dir).events.at(-1).type,'startup-no-work'); diagnosed=true;
  }}),/No useful work confirmed/);
  assert.equal(diagnosed,true);
});
