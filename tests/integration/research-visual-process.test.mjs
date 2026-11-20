import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,realpath,writeFile,symlink,rm,access} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

// Actual isolated CPython and shared process runner, controlled package doubles. No visual quality claim.
let api, runtime, files, root, model, inspected, environment, executions;
before(async()=>{
  [api,runtime,files] = await Promise.all([loadResearchTestApi(),
    ...['visual-python-adapter','visual-model-files'].map(name=>importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
      {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']}))]);
  const python = JSON.parse(execFileSync('python3',['-I','-S','-c',
    'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'],{encoding:'utf8'}));
  assert.match(python.version,/^3\.14\.\d+$/);
  root = await realpath(await mkdtemp(join(tmpdir(),'roc-visual-process-')));
  const venv=join(root,'venv'), packages=join(venv,'lib/python3.14/site-packages'), workspace=join(root,'workspace'), jobs=join(root,'jobs');
  for(const path of [packages,workspace,jobs,join(venv,'bin'),join(root,'model')]) await mkdir(path,{recursive:true});
  const executable=join(venv,'bin/python3'); await symlink(python.executable,executable);
  await writeFile(join(venv,'pyvenv.cfg'),`home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  const dist=join(packages,'sentence_transformers-6.0.1.dist-info'); await mkdir(dist);
  await writeFile(join(dist,'METADATA'),'Metadata-Version: 2.4\nName: sentence-transformers\nVersion: 6.0.1\n');
  await writeFile(join(packages,'sitecustomize.py'),'raise RuntimeError("unexpected site execution")\n');
  await writeFile(join(packages,'torch.py'),`def set_num_threads(n):
    assert n == 2
def set_num_interop_threads(n):
    assert n == 1
class inference_mode:
    def __enter__(self): return self
    def __exit__(self, *args): pass
`);
  await writeFile(join(packages,'numpy.py'),`import struct
class Matrix:
    ndim = 2
    shape = (2, 2)
    def tobytes(self, order):
        assert order == "C"
        return struct.pack("<4f", 1, 0, 0, 1)
def asarray(value, dtype):
    assert dtype == "<f4"
    return Matrix()
class Finite:
    def all(self): return True
def isfinite(value): return Finite()
`);
  await mkdir(join(packages,'PIL'));
  await writeFile(join(packages,'PIL/__init__.py'),'');
  await writeFile(join(packages,'PIL/Image.py'),`import os
class Image:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def convert(self, kind):
        assert kind == "RGB"
        return self
def open(path):
    assert os.path.getsize(path) > 0
    return Image()
`);
  await writeFile(join(packages,'sentence_transformers.py'),`import time
class MultiVectorEncoder:
    def __init__(self, path, **kwargs):
        assert kwargs == {"local_files_only": True, "trust_remote_code": False, "device": "cpu", "model_kwargs": {"use_safetensors": True}}
    def encode_query(self, values, **kwargs):
        assert kwargs == {"convert_to_numpy": True, "normalize_embeddings": True, "show_progress_bar": False}
        if values[0] == "cancel": time.sleep(30)
        return ["controlled matrix"]
    def encode_document(self, values, **kwargs):
        assert kwargs == {"batch_size": 1, "convert_to_numpy": True, "normalize_embeddings": True, "show_progress_bar": False}
        return ["controlled matrix"]
`);
  await writeFile(join(workspace,'roc-python.lock.json'),JSON.stringify({schemaVersion:1,
    python:{implementation:'cpython',version:python.version,platform:'darwin',architecture:'arm64'},
    distributions:[{name:'sentence-transformers',version:'6.0.1'}]}));
  const inspect=async(jobDir,signal,admission)=>api.inspectPythonExperimentEnvironment({workspace,selectedExecutable:executable,
    jobDir,signal,admission,onProbe(){},run:api.runResearchProcess});
  inspected=await inspect(jobs,new AbortController().signal,{projectId:'visual-fixture',priority:'background'});
  environment={resolve:async(_selection,jobDir,signal,admission)=>{
    assert.equal(admission.priority,'background');
    const current=await inspect(jobDir,signal,admission); assert.equal(current.metadataHash,inspected.metadataHash);return current;
  }};
  const modelPath=join(root,'model');
  await writeFile(join(modelPath,'config.json'),JSON.stringify({architectures:['ColPaliForRetrieval']}));
  await writeFile(join(modelPath,'model.safetensors'),'controlled fixture only');
  model={family:'colpali',path:modelPath,sha256:(await files.inspectVisualModel(modelPath,'colpali',new AbortController().signal)).sha256,
    selectionId:'fixture',selectionHash:'e'.repeat(64)};
  executions=[];
});
after(async()=>{if(root)await rm(root,{recursive:true,force:true});api?.dispose();});
function adapter(onRun = request=>api.runResearchProcess(request)) {
  return new runtime.PythonVisualRetrievalAdapter(environment,async request=>{
    executions.push(request);assert.equal(request.admission.priority,'background');assert.equal(request.admission.resourceClass,'compute');
    assert.equal(request.networkAccess,'none');assert.equal(request.allowGpuAcceleration,false);
    return onRun(request);
  });
}
const input = query=>({projectId:'visual-fixture',model,query,images:query===null?[Buffer.from('controlled image bytes')]:[]});
test('actual fixed bootstrap returns validated binary token matrices and cleans temporary paths after release',async()=>{
  for(const query of [null,'diagram']) {
    const result=await adapter().encode(input(query),new AbortController().signal);
    assert.deepEqual([...result.matrices[0].values],[1,0,0,1]);result.assertCurrent();
    await assert.rejects(access(executions.at(-1).cwd),{code:'ENOENT'});
  }
});
test('changed startup report is rejected before third-party imports; invalid output is rejected after process release',async()=>{
  await assert.rejects(adapter(async request=>{
    const wire=JSON.parse(request.input);wire.startup.version='3.14.999';
    const result=await api.runResearchProcess({...request,input:JSON.stringify(wire)});
    assert.equal(result.stdout,'');assert.match(result.stderr,/research_python_startup_changed/);return result;
  }).encode(input('diagram'),new AbortController().signal),/visual_inference_failed/);
  await assert.rejects(adapter(async request=>{
    const result=await api.runResearchProcess(request);
    const wire=JSON.parse(request.input);await writeFile(join(wire.outputDir,'0.f32'),Buffer.alloc(16));return result;
  }).encode(input('diagram'),new AbortController().signal),/not_normalized/);
});
test('actual cancellation waits for process settlement before deleting model input scratch directories',async()=>{
  const controller=new AbortController();let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const runtime=adapter(async request=>{started();return api.runResearchProcess(request);});
  const pending=runtime.encode(input('cancel'),controller.signal);pending.catch(()=>{});
  await ready;await delay(300);controller.abort(new Error('fixture cancellation'));
  await assert.rejects(pending,/cancel|abort/i);
  await assert.rejects(access(executions.at(-1).cwd),{code:'ENOENT'});
});
